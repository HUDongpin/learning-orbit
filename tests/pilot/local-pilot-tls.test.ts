import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  OPENSSL_PATH,
  createLocalTlsMaterial,
  removeLocalTlsMaterial,
} from "../../scripts/local-pilot/tls.mjs";
import { createLocalPilotEvidenceRecorder } from "../../scripts/local-pilot/stage-evidence.mjs";

describe("local pilot TLS material", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("creates short-lived 0600 material with both required SANs", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lo-pilot-tls-parent-"));
    cleanup.push(parent);
    const commandEvidence = createLocalPilotEvidenceRecorder({ id: "disposable-worktree" });
    const material = await createLocalTlsMaterial({
      parentDirectory: parent,
      runId: "fedcba9876543210",
      opensslPath: OPENSSL_PATH,
      commandEvidence,
    });
    expect((await stat(material.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(material.privateKeyPath)).mode & 0o777).toBe(0o600);
    expect((await stat(material.certificatePath)).mode & 0o777).toBe(0o600);
    expect(await readFile(material.privateKeyPath, "utf8")).toContain("PRIVATE KEY");
    expect(material.sans).toEqual(["IP:127.0.0.1", "DNS:localhost"]);
    expect(material.notAfter.getTime()).toBeGreaterThan(Date.now());
    expect(material.notAfter.getTime()).toBeLessThanOrEqual(Date.now() + 25 * 60 * 60 * 1000);
    expect(commandEvidence.snapshot().commands).toEqual([
      expect.objectContaining({
        argv: expect.arrayContaining(["openssl", "req", "<absolute:key.pem>", "<absolute:cert.pem>"]),
        exitCode: 0,
        outputSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    expect(JSON.stringify(commandEvidence.snapshot())).not.toContain(parent);

    await removeLocalTlsMaterial(material, parent);
    await expect(stat(material.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe run IDs and out-of-scope cleanup", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lo-pilot-tls-parent-"));
    cleanup.push(parent);
    await expect(createLocalTlsMaterial({
      parentDirectory: parent,
      runId: "../../escape",
      opensslPath: OPENSSL_PATH,
    })).rejects.toThrow("LOCAL_PILOT_RUN_ID_INVALID");
    await expect(removeLocalTlsMaterial({
      directory: parent,
      privateKeyPath: join(parent, "key.pem"),
      certificatePath: join(parent, "cert.pem"),
      sans: [],
      notAfter: new Date(),
      runId: "0123456789abcdef",
    }, parent)).rejects.toThrow("LOCAL_PILOT_TLS_DELETE_SCOPE_INVALID");
  });

  it("refuses cleanup after owner-only certificate mode is weakened", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lo-pilot-tls-parent-"));
    cleanup.push(parent);
    const material = await createLocalTlsMaterial({
      parentDirectory: parent,
      runId: "0011223344556677",
      opensslPath: OPENSSL_PATH,
    });
    await chmod(material.certificatePath, 0o644);
    await expect(removeLocalTlsMaterial(material, parent)).rejects.toThrow(
      "LOCAL_PILOT_TLS_DELETE_SCOPE_INVALID",
    );
    expect(await readFile(material.certificatePath, "utf8")).toContain("BEGIN CERTIFICATE");
  });
});
