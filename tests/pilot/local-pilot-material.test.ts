import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildRunIdentity } from "../../scripts/local-pilot/ownership.mjs";
import {
  buildChildEnvironments,
  createRuntimeMaterial,
  removeRuntimeMaterial,
} from "../../scripts/local-pilot/material.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

describe("local pilot runtime material and least-privilege environments", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("creates owner-only random secrets and an Ed25519 trust pair", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lo-pilot-material-parent-"));
    cleanup.push(parent);
    const identity = buildRunIdentity({
      runId: "deadc0dedeadc0de",
      sourceSha: "1".repeat(40),
      creatorPid: process.pid,
    });
    const material = await createRuntimeMaterial({ parentDirectory: parent, identity });
    expect((await stat(material.directory)).mode & 0o777).toBe(0o700);
    for (const path of [
      material.privateKeyPath,
      material.trustFilePath,
      material.postgresPasswordPath,
      material.roomCodePepperPath,
      material.auditSaltPath,
      material.analyticsPseudonymKeyPath,
      material.markerPath,
    ]) {
      const info = await stat(path);
      expect(info.mode & 0o777).toBe(0o600);
      expect(info.uid).toBe(process.getuid?.());
    }
    expect(material.postgresPassword).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(material.roomCodePepper).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(material.auditSalt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(material.analyticsPseudonymKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set([
      material.postgresPassword,
      material.roomCodePepper,
      material.auditSalt,
      material.analyticsPseudonymKey,
    ]).size).toBe(4);
    expect((await readFile(material.postgresPasswordPath, "utf8")).trim() === material.postgresPassword).toBe(true);
    expect((await readFile(material.roomCodePepperPath, "utf8")).trim() === material.roomCodePepper).toBe(true);
    expect((await readFile(material.auditSaltPath, "utf8")).trim() === material.auditSalt).toBe(true);
    expect((await readFile(material.analyticsPseudonymKeyPath, "utf8")).trim() === material.analyticsPseudonymKey).toBe(true);
    const trust = JSON.parse(await readFile(material.trustFilePath, "utf8"));
    expect(trust).toEqual({
      version: 1,
      keys: [{
        issuer: "learning-orbit-local-pilot",
        keyId: `pilot-${identity.runId}`,
        publicKeyPem: expect.stringContaining("BEGIN PUBLIC KEY"),
      }],
    });
    const python = spawnSync(
      resolve(repoRoot, ".venv/bin/python"),
      ["-c", "from pathlib import Path; from learning_orbit_worker.service_assertion import load_private_ed25519_key; load_private_ed25519_key(Path(__import__('sys').argv[1]))", material.privateKeyPath],
      {
        cwd: repoRoot,
        env: { ...process.env, PYTHONPATH: resolve(repoRoot, "services/worker/src") },
        encoding: "utf8",
      },
    );
    expect(python.status, python.stderr).toBe(0);
    expect(python.stdout).toBe("");
  });

  it("gives each child only its approved secret subset", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lo-pilot-material-parent-"));
    cleanup.push(parent);
    const identity = buildRunIdentity({
      runId: "c001d00dc001d00d",
      sourceSha: "2".repeat(40),
      creatorPid: process.pid,
    });
    const material = await createRuntimeMaterial({ parentDirectory: parent, identity });
    const environments = buildChildEnvironments({
      material,
      databaseUrl: `postgres://learning_orbit:${encodeURIComponent(material.postgresPassword)}@127.0.0.1:55432/${identity.databaseName}`,
      baseEnvironment: { PATH: "/approved/bin", TMPDIR: parent },
    });
    expect(environments.server).toMatchObject({
      DATABASE_URL: expect.any(String),
      LO_PUBLIC_BASE_ORIGIN: "https://127.0.0.1:3000",
      LO_ALLOWED_ORIGINS: "https://127.0.0.1:3000",
      LO_TRUSTED_PROXY_CIDRS: "",
      LO_SMTP_HOST: "127.0.0.1",
      LO_SMTP_PORT: "1025",
      ROOM_CODE_PEPPER_CURRENT_VERSION: "1",
      LO_SERVICE_ASSERTION_TRUST_FILE: material.trustFilePath,
    });
    expect(environments.server).not.toHaveProperty("LO_WORKER_ASSERTION_PRIVATE_KEY_FILE");
    expect(environments.server).not.toHaveProperty("LO_ANALYTICS_PSEUDONYM_KEY");
    expect(environments.worker).toMatchObject({
      DATABASE_URL: expect.any(String),
      LO_WORKER_ID: `pilot-worker-${identity.runId}`,
      LO_ANALYTICS_PSEUDONYM_KEY: material.analyticsPseudonymKey,
      LO_WORKER_ASSERTION_PRIVATE_KEY_FILE: material.privateKeyPath,
    });
    expect(environments.worker).not.toHaveProperty("ROOM_CODE_PEPPER_V1");
    expect(environments.worker).not.toHaveProperty("LO_AUDIT_SALT");
    expect(environments.next).toEqual({
      PATH: "/approved/bin",
      TMPDIR: parent,
      NODE_ENV: "development",
      NEXT_TELEMETRY_DISABLED: "1",
      LO_LOCAL_SAME_ORIGIN_PROXY: "1",
    });
    expect(environments.playwright).toEqual({
      PATH: "/approved/bin",
      TMPDIR: parent,
      LO_PUBLIC_BASE_ORIGIN: "https://127.0.0.1:3000",
    });
  });

  it("deletes only the exact run-owned material directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lo-pilot-material-parent-"));
    cleanup.push(parent);
    const identity = buildRunIdentity({
      runId: "facefeedfacefeed",
      sourceSha: "3".repeat(40),
      creatorPid: process.pid,
    });
    const material = await createRuntimeMaterial({ parentDirectory: parent, identity });
    await removeRuntimeMaterial({ material, parentDirectory: parent, identity });
    await expect(stat(material.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(removeRuntimeMaterial({
      material: { ...material, directory: parent },
      parentDirectory: parent,
      identity,
    })).rejects.toThrow("LOCAL_PILOT_MATERIAL_DELETE_SCOPE_INVALID");
  });
});
