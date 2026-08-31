import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertContentFreeReceipt,
  assertFinalRepositoryState,
  hashEvidenceSet,
  writeLocalPilotReceipt,
} from "../../scripts/local-pilot/evidence.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local pilot evidence and final cleanliness", () => {
  it("hashes closed file sets with path-sensitive deterministic SHA-256 values", async () => {
    const root = await mkdtemp(join(tmpdir(), "lo-evidence-"));
    roots.push(root);
    await mkdir(join(root, "migrations"));
    await writeFile(join(root, "lock.txt"), "locked\n");
    await writeFile(join(root, "migrations", "001.sql"), "select 1;\n");
    await writeFile(join(root, "migrations", "002.sql"), "select 2;\n");
    const first = await hashEvidenceSet(root, {
      lock: ["lock.txt"],
      migrations: ["migrations/001.sql", "migrations/002.sql"],
    });
    expect(first).toEqual({
      lock: expect.stringMatching(/^[0-9a-f]{64}$/),
      migrations: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    await writeFile(join(root, "migrations", "002.sql"), "select 3;\n");
    const second = await hashEvidenceSet(root, {
      lock: ["lock.txt"],
      migrations: ["migrations/001.sql", "migrations/002.sql"],
    });
    expect(second.lock).toBe(first.lock);
    expect(second.migrations).not.toBe(first.migrations);
  });

  it("requires unchanged HEAD, empty status, unchanged evidence, and all released ports", async () => {
    const root = await mkdtemp(join(tmpdir(), "lo-final-state-"));
    roots.push(root);
    await writeFile(join(root, "lock.txt"), "locked\n");
    const expectedHashes = await hashEvidenceSet(root, { lock: ["lock.txt"] });
    const sha = "a".repeat(40);
    const runGit = async (argv: string[]) => ({
      stdout: argv[0] === "status" ? "" : `${sha}\n`,
    });
    await expect(assertFinalRepositoryState({
      repository: root,
      sourceSha: sha,
      expectedHashes,
      evidenceSet: { lock: ["lock.txt"] },
      runGit,
      checkPort: async () => true,
    })).resolves.toBeUndefined();
    await expect(assertFinalRepositoryState({
      repository: root,
      sourceSha: sha,
      expectedHashes,
      evidenceSet: { lock: ["lock.txt"] },
      runGit,
      checkPort: async (port: number) => port !== 3001,
    })).rejects.toThrow("LOCAL_PILOT_PORT_NOT_RELEASED_3001");
    await writeFile(join(root, "lock.txt"), "drift\n");
    await expect(assertFinalRepositoryState({
      repository: root,
      sourceSha: sha,
      expectedHashes,
      evidenceSet: { lock: ["lock.txt"] },
      runGit,
      checkPort: async () => true,
    })).rejects.toThrow("LOCAL_PILOT_EVIDENCE_HASH_DRIFT");
  });

  it("writes one owner-only content-free receipt and rejects secret-bearing shapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "lo-receipt-"));
    roots.push(root);
    const receipt = {
      schemaVersion: 1,
      runId: "0123456789abcdef",
      sourceSha: "b".repeat(40),
      status: "failed",
      failureCode: "LOCAL_PILOT_DOCKER_UNAVAILABLE",
      runtimes: { node: "v24.19.0", pnpm: "11.19.0", python: "Python 3.12.13" },
      hashes: { lock: "c".repeat(64) },
      gates: [],
      cleanup: [],
      noSkipCount: 0,
    };
    expect(assertContentFreeReceipt(receipt)).toBe(receipt);
    const path = await writeLocalPilotReceipt({ repository: root, receipt });
    expect((await stat(join(root, "test-results"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "test-results", "local-pilot"))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(receipt);
    await expect(writeLocalPilotReceipt({ repository: root, receipt })).rejects.toThrow(
      "LOCAL_PILOT_RECEIPT_EXISTS",
    );
    expect(() => assertContentFreeReceipt({ ...receipt, teacherEmail: "hidden@example.invalid" }))
      .toThrow("LOCAL_PILOT_RECEIPT_SENSITIVE");
    expect(() => assertContentFreeReceipt({ ...receipt, gates: [{ argv: ["--token=hidden"] }] }))
      .toThrow("LOCAL_PILOT_RECEIPT_SENSITIVE");

    await chmod(join(root, "test-results", "local-pilot"), 0o755);
    await expect(writeLocalPilotReceipt({
      repository: root,
      receipt: { ...receipt, runId: "fedcba9876543210" },
    })).rejects.toThrow("LOCAL_PILOT_RECEIPT_DIRECTORY_INVALID");
  });

  it("accepts a safe shared report parent while keeping the pilot receipt directory owner-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "lo-receipt-parent-"));
    roots.push(root);
    const reportParent = join(root, "test-results");
    await mkdir(reportParent, { mode: 0o755 });
    await chmod(reportParent, 0o755);
    const receipt = {
      schemaVersion: 1,
      runId: "0123456789abcdef",
      sourceSha: "b".repeat(40),
      status: "failed",
      failureCode: "LOCAL_PILOT_DOCKER_UNAVAILABLE",
      gates: [],
      cleanup: [],
    };

    const receiptPath = await writeLocalPilotReceipt({ repository: root, receipt });
    expect((await stat(reportParent)).mode & 0o777).toBe(0o755);
    expect((await stat(join(reportParent, "local-pilot"))).mode & 0o777).toBe(0o700);
    expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);

    const writableRoot = await mkdtemp(join(tmpdir(), "lo-receipt-writable-parent-"));
    roots.push(writableRoot);
    const writableParent = join(writableRoot, "test-results");
    await mkdir(writableParent, { mode: 0o777 });
    await chmod(writableParent, 0o777);
    await expect(writeLocalPilotReceipt({
      repository: writableRoot,
      receipt: { ...receipt, runId: "fedcba9876543210" },
    })).rejects.toThrow("LOCAL_PILOT_RECEIPT_DIRECTORY_INVALID");
  });
});
