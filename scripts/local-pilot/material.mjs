import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { buildRunIdentity } from "./ownership.mjs";

const fail = (code) => {
  throw new Error(code);
};

function assertIdentity(identity) {
  const rebuilt = buildRunIdentity(identity);
  if (rebuilt.composeProject !== identity.composeProject
    || rebuilt.databaseName !== identity.databaseName) {
    fail("LOCAL_PILOT_IDENTITY_INVALID");
  }
}

async function realDirectory(path, code) {
  if (!isAbsolute(path)) fail(code);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(code);
  return realpath(path);
}

function secret() {
  return randomBytes(32).toString("base64url");
}

function exactKeys(value, keys) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

export async function createRuntimeMaterial({ parentDirectory, identity }) {
  assertIdentity(identity);
  const parent = await realDirectory(parentDirectory, "LOCAL_PILOT_MATERIAL_PARENT_INVALID");
  const directory = join(parent, `lo-pilot-material-${identity.runId}`);
  try {
    await mkdir(directory, { mode: 0o700, recursive: false });
  } catch {
    fail("LOCAL_PILOT_MATERIAL_TARGET_EXISTS");
  }
  await chmod(directory, 0o700);
  const privateKeyPath = join(directory, "worker-ed25519-private.pem");
  const trustFilePath = join(directory, "service-assertion-trust.json");
  const postgresPasswordPath = join(directory, "postgres-password.secret");
  const roomCodePepperPath = join(directory, "room-code-pepper.secret");
  const auditSaltPath = join(directory, "audit-salt.secret");
  const analyticsPseudonymKeyPath = join(directory, "analytics-pseudonym-key.secret");
  const markerPath = join(directory, "runtime-material.json");
  const issuer = "learning-orbit-local-pilot";
  const keyId = `pilot-${identity.runId}`;
  try {
    const postgresPassword = secret();
    const roomCodePepper = secret();
    const auditSalt = secret();
    const analyticsPseudonymKey = secret();
    const pair = generateKeyPairSync("ed25519");
    const privateKeyPem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const trust = { version: 1, keys: [{ issuer, keyId, publicKeyPem }] };
    const marker = {
      runId: identity.runId,
      sourceSha: identity.sourceSha,
      creatorPid: identity.creatorPid,
      issuer,
      keyId,
      privateKeyFile: basename(privateKeyPath),
      trustFile: basename(trustFilePath),
      postgresPasswordFile: basename(postgresPasswordPath),
      roomCodePepperFile: basename(roomCodePepperPath),
      auditSaltFile: basename(auditSaltPath),
      analyticsPseudonymKeyFile: basename(analyticsPseudonymKeyPath),
    };
    const writes = await Promise.allSettled([
      writeFile(privateKeyPath, privateKeyPem, { flag: "wx", mode: 0o600 }),
      writeFile(trustFilePath, `${JSON.stringify(trust)}\n`, { flag: "wx", mode: 0o600 }),
      writeFile(postgresPasswordPath, `${postgresPassword}\n`, { flag: "wx", mode: 0o600 }),
      writeFile(roomCodePepperPath, `${roomCodePepper}\n`, { flag: "wx", mode: 0o600 }),
      writeFile(auditSaltPath, `${auditSalt}\n`, { flag: "wx", mode: 0o600 }),
      writeFile(analyticsPseudonymKeyPath, `${analyticsPseudonymKey}\n`, { flag: "wx", mode: 0o600 }),
      writeFile(markerPath, `${JSON.stringify(marker)}\n`, { flag: "wx", mode: 0o600 }),
    ]);
    if (writes.some((result) => result.status === "rejected")) {
      throw new Error("LOCAL_PILOT_MATERIAL_GENERATION_FAILED");
    }
    await Promise.all([
      chmod(privateKeyPath, 0o600),
      chmod(trustFilePath, 0o600),
      chmod(postgresPasswordPath, 0o600),
      chmod(roomCodePepperPath, 0o600),
      chmod(auditSaltPath, 0o600),
      chmod(analyticsPseudonymKeyPath, 0o600),
      chmod(markerPath, 0o600),
    ]);
    return Object.freeze({
      directory,
      privateKeyPath,
      trustFilePath,
      postgresPasswordPath,
      roomCodePepperPath,
      auditSaltPath,
      analyticsPseudonymKeyPath,
      markerPath,
      issuer,
      keyId,
      runId: identity.runId,
      sourceSha: identity.sourceSha,
      creatorPid: identity.creatorPid,
      postgresPassword,
      roomCodePepper,
      auditSalt,
      analyticsPseudonymKey,
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error instanceof Error && error.message.startsWith("LOCAL_PILOT_")) throw error;
    fail("LOCAL_PILOT_MATERIAL_GENERATION_FAILED");
  }
}

function commonEnvironment(baseEnvironment) {
  if (!baseEnvironment || typeof baseEnvironment.PATH !== "string" || baseEnvironment.PATH.length === 0
    || typeof baseEnvironment.TMPDIR !== "string" || !isAbsolute(baseEnvironment.TMPDIR)) {
    fail("LOCAL_PILOT_BASE_ENVIRONMENT_INVALID");
  }
  return { PATH: baseEnvironment.PATH, TMPDIR: baseEnvironment.TMPDIR };
}

function assertDatabaseUrl(databaseUrl, material) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    fail("LOCAL_PILOT_DATABASE_URL_INVALID");
  }
  const expectedDatabase = `lo_pilot_${material.runId}_test`;
  if (parsed.protocol !== "postgres:" || parsed.hostname !== "127.0.0.1"
    || parsed.port !== "55432" || parsed.username !== "learning_orbit"
    || parsed.password !== material.postgresPassword
    || parsed.pathname !== `/${expectedDatabase}` || parsed.search !== "" || parsed.hash !== "") {
    fail("LOCAL_PILOT_DATABASE_URL_INVALID");
  }
}

export function buildChildEnvironments({ material, databaseUrl, baseEnvironment }) {
  if (!material || !/^[0-9a-f]{16}$/.test(material.runId ?? "")) {
    fail("LOCAL_PILOT_MATERIAL_INVALID");
  }
  assertDatabaseUrl(databaseUrl, material);
  const common = commonEnvironment(baseEnvironment);
  return Object.freeze({
    server: Object.freeze({
      ...common,
      NODE_ENV: "development",
      PORT: "3001",
      DATABASE_URL: databaseUrl,
      LO_PUBLIC_BASE_ORIGIN: "https://127.0.0.1:3000",
      LO_ALLOWED_ORIGINS: "https://127.0.0.1:3000",
      LO_TRUSTED_PROXY_CIDRS: "",
      LO_STORAGE_BROWSER_ORIGINS: "",
      LO_SMTP_HOST: "127.0.0.1",
      LO_SMTP_PORT: "1025",
      LO_SMTP_FROM: "no-reply@learning-orbit.local",
      ROOM_CODE_PEPPER_CURRENT_VERSION: "1",
      ROOM_CODE_PEPPER_V1: material.roomCodePepper,
      LO_AUDIT_SALT: material.auditSalt,
      LO_SERVICE_ASSERTION_TRUST_FILE: material.trustFilePath,
    }),
    worker: Object.freeze({
      ...common,
      DATABASE_URL: databaseUrl,
      LO_WORKER_ID: `pilot-worker-${material.runId}`,
      LO_ANALYTICS_PSEUDONYM_KEY: material.analyticsPseudonymKey,
      LO_WORKER_ASSERTION_PRIVATE_KEY_FILE: material.privateKeyPath,
      LO_SERVICE_ASSERTION_ISSUER: material.issuer,
      LO_SERVICE_ASSERTION_KEY_ID: material.keyId,
      LO_INTERNAL_BASE_ORIGIN: "http://127.0.0.1:3001",
    }),
    next: Object.freeze({
      ...common,
      NODE_ENV: "development",
      NEXT_TELEMETRY_DISABLED: "1",
      LO_LOCAL_SAME_ORIGIN_PROXY: "1",
    }),
    playwright: Object.freeze({
      ...common,
      LO_PUBLIC_BASE_ORIGIN: "https://127.0.0.1:3000",
    }),
  });
}

export async function removeRuntimeMaterial({ material, parentDirectory, identity }) {
  assertIdentity(identity);
  const parent = await realDirectory(parentDirectory, "LOCAL_PILOT_MATERIAL_DELETE_SCOPE_INVALID");
  if (!material || resolve(material.directory) !== resolve(join(parent, `lo-pilot-material-${identity.runId}`))
    || dirname(resolve(material.directory)) !== parent
    || material.privateKeyPath !== join(material.directory, "worker-ed25519-private.pem")
    || material.trustFilePath !== join(material.directory, "service-assertion-trust.json")
    || material.postgresPasswordPath !== join(material.directory, "postgres-password.secret")
    || material.roomCodePepperPath !== join(material.directory, "room-code-pepper.secret")
    || material.auditSaltPath !== join(material.directory, "audit-salt.secret")
    || material.analyticsPseudonymKeyPath !== join(material.directory, "analytics-pseudonym-key.secret")
    || material.markerPath !== join(material.directory, "runtime-material.json")) {
    fail("LOCAL_PILOT_MATERIAL_DELETE_SCOPE_INVALID");
  }
  const directory = await realDirectory(material.directory, "LOCAL_PILOT_MATERIAL_DELETE_SCOPE_INVALID");
  if (dirname(directory) !== parent) fail("LOCAL_PILOT_MATERIAL_DELETE_SCOPE_INVALID");
  for (const path of [
    material.privateKeyPath,
    material.trustFilePath,
    material.postgresPasswordPath,
    material.roomCodePepperPath,
    material.auditSaltPath,
    material.analyticsPseudonymKeyPath,
    material.markerPath,
  ]) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600
      || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      fail("LOCAL_PILOT_MATERIAL_DELETE_SCOPE_INVALID");
    }
  }
  const marker = JSON.parse(await readFile(material.markerPath, "utf8"));
  const markerKeys = [
    "runId", "sourceSha", "creatorPid", "issuer", "keyId", "privateKeyFile", "trustFile",
    "postgresPasswordFile", "roomCodePepperFile", "auditSaltFile", "analyticsPseudonymKeyFile",
  ];
  if (!exactKeys(marker, markerKeys)
    || marker.runId !== identity.runId || marker.sourceSha !== identity.sourceSha
    || marker.creatorPid !== identity.creatorPid || marker.issuer !== material.issuer
    || marker.keyId !== material.keyId
    || marker.privateKeyFile !== basename(material.privateKeyPath)
    || marker.trustFile !== basename(material.trustFilePath)
    || marker.postgresPasswordFile !== basename(material.postgresPasswordPath)
    || marker.roomCodePepperFile !== basename(material.roomCodePepperPath)
    || marker.auditSaltFile !== basename(material.auditSaltPath)
    || marker.analyticsPseudonymKeyFile !== basename(material.analyticsPseudonymKeyPath)) {
    fail("LOCAL_PILOT_MATERIAL_OWNERSHIP_MISMATCH");
  }
  await rm(directory, { recursive: true });
}
