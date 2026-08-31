import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

export const OPENSSL_PATH = "/opt/homebrew/bin/openssl";
const execFileAsync = promisify(execFile);

const fail = (code) => {
  throw new Error(code);
};

function assertRunId(runId) {
  if (typeof runId !== "string" || !/^[0-9a-f]{16}$/.test(runId)) {
    fail("LOCAL_PILOT_RUN_ID_INVALID");
  }
}

async function assertRealDirectory(directory, code) {
  if (!isAbsolute(directory)) fail(code);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(code);
  return realpath(directory);
}

export async function createLocalTlsMaterial({
  parentDirectory,
  runId,
  opensslPath = OPENSSL_PATH,
  commandEvidence,
}) {
  assertRunId(runId);
  if (commandEvidence !== undefined && typeof commandEvidence?.recordCommand !== "function") {
    fail("LOCAL_PILOT_TLS_EVIDENCE_INVALID");
  }
  const parent = await assertRealDirectory(parentDirectory, "LOCAL_PILOT_TLS_PARENT_INVALID");
  if (opensslPath !== OPENSSL_PATH) fail("LOCAL_PILOT_OPENSSL_PATH_INVALID");
  const opensslInfo = await lstat(opensslPath);
  if ((!opensslInfo.isFile() && !opensslInfo.isSymbolicLink())) fail("LOCAL_PILOT_OPENSSL_UNAVAILABLE");

  const directory = join(parent, `lo-pilot-tls-${runId}`);
  await mkdir(directory, { mode: 0o700, recursive: false });
  await chmod(directory, 0o700);
  const privateKeyPath = join(directory, "key.pem");
  const certificatePath = join(directory, "cert.pem");
  const argv = [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "-addext", "basicConstraints=critical,CA:FALSE",
    "-addext", "keyUsage=critical,digitalSignature,keyEncipherment",
    "-addext", "extendedKeyUsage=serverAuth",
    "-keyout", privateKeyPath,
    "-out", certificatePath,
  ];
  try {
    const startedAt = new Date().toISOString();
    let commandResult;
    try {
      commandResult = await execFileAsync(opensslPath, argv, {
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 30_000,
        killSignal: "SIGTERM",
      });
    } catch (error) {
      commandEvidence?.recordCommand({
        executable: opensslPath,
        argv,
        exitCode: Number.isSafeInteger(error?.code) ? error.code : 1,
        startedAt,
        endedAt: new Date().toISOString(),
        stdout: error?.stdout,
        stderr: error?.stderr,
      });
      throw error;
    }
    commandEvidence?.recordCommand({
      executable: opensslPath,
      argv,
      exitCode: 0,
      startedAt,
      endedAt: new Date().toISOString(),
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
    });
    await Promise.all([chmod(privateKeyPath, 0o600), chmod(certificatePath, 0o600)]);
    const certificate = new X509Certificate(await readFile(certificatePath));
    if (certificate.checkIP("127.0.0.1") !== "127.0.0.1"
      || certificate.checkHost("localhost") !== "localhost") {
      fail("LOCAL_PILOT_TLS_SAN_INVALID");
    }
    const notAfter = new Date(certificate.validTo);
    const remaining = notAfter.getTime() - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 25 * 60 * 60 * 1000) {
      fail("LOCAL_PILOT_TLS_LIFETIME_INVALID");
    }
    return Object.freeze({
      directory,
      privateKeyPath,
      certificatePath,
      sans: Object.freeze(["IP:127.0.0.1", "DNS:localhost"]),
      notAfter,
      runId,
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error instanceof Error && error.message.startsWith("LOCAL_PILOT_")) throw error;
    fail("LOCAL_PILOT_TLS_GENERATION_FAILED");
  }
}

export async function removeLocalTlsMaterial(material, expectedParent) {
  assertRunId(material.runId);
  if (!isAbsolute(material.directory) || !isAbsolute(expectedParent)
    || basename(material.directory) !== `lo-pilot-tls-${material.runId}`
    || material.privateKeyPath !== join(material.directory, "key.pem")
    || material.certificatePath !== join(material.directory, "cert.pem")) {
    fail("LOCAL_PILOT_TLS_DELETE_SCOPE_INVALID");
  }
  const [directory, parent] = await Promise.all([
    assertRealDirectory(material.directory, "LOCAL_PILOT_TLS_DELETE_SCOPE_INVALID"),
    assertRealDirectory(expectedParent, "LOCAL_PILOT_TLS_DELETE_SCOPE_INVALID"),
  ]);
  if (dirname(directory) !== parent) fail("LOCAL_PILOT_TLS_DELETE_SCOPE_INVALID");
  const directoryInfo = await lstat(directory);
  if ((directoryInfo.mode & 0o777) !== 0o700
    || (typeof process.getuid === "function" && directoryInfo.uid !== process.getuid())) {
    fail("LOCAL_PILOT_TLS_DELETE_SCOPE_INVALID");
  }
  for (const path of [material.privateKeyPath, material.certificatePath]) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600
      || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      fail("LOCAL_PILOT_TLS_DELETE_SCOPE_INVALID");
    }
  }
  await rm(directory, { recursive: true });
}
