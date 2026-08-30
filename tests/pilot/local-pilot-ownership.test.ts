import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertOwnershipMarker,
  buildRunIdentity,
  removeOwnedDirectory,
  writeOwnershipMarker,
} from "../../scripts/local-pilot/ownership.mjs";

describe("local pilot resource ownership", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("derives bounded run-owned Compose and database identifiers", () => {
    const identity = buildRunIdentity({
      runId: "9f7c4e2b1a608d3c",
      sourceSha: "b".repeat(40),
      creatorPid: 4123,
    });
    expect(identity).toEqual({
      runId: "9f7c4e2b1a608d3c",
      sourceSha: "b".repeat(40),
      creatorPid: 4123,
      composeProject: "lo-pilot-9f7c4e2b1a608d3c",
      databaseName: "lo_pilot_9f7c4e2b1a608d3c_test",
    });
    expect(identity.databaseName.endsWith("_test")).toBe(true);
    expect(() => buildRunIdentity({
      runId: "../escape",
      sourceSha: "b".repeat(40),
      creatorPid: 1,
    })).toThrow("LOCAL_PILOT_RUN_ID_INVALID");
    expect(() => buildRunIdentity({
      runId: "9f7c4e2b1a608d3c",
      sourceSha: "short",
      creatorPid: 1,
    })).toThrow("LOCAL_PILOT_SOURCE_SHA_INVALID");
  });

  it("writes a closed content-free marker with mode 0600", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lo-pilot-owner-test-"));
    cleanup.push(parent);
    const identity = buildRunIdentity({
      runId: "0123456789abcdef",
      sourceSha: "c".repeat(40),
      creatorPid: process.pid,
    });
    const directory = join(parent, `lo-pilot-run-${identity.runId}`);
    const markerPath = await writeOwnershipMarker(directory, identity);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(markerPath)).mode & 0o777).toBe(0o600);
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    expect(assertOwnershipMarker(marker, identity)).toEqual(marker);
    expect(Object.keys(marker).sort()).toEqual([
      "composeProject",
      "creatorPid",
      "databaseName",
      "runId",
      "sourceSha",
    ]);
    expect(() => assertOwnershipMarker({ ...marker, token: "forbidden" }, identity)).toThrow(
      "LOCAL_PILOT_OWNERSHIP_MARKER_INVALID",
    );
    expect(() => assertOwnershipMarker({ ...marker, creatorPid: process.pid + 1 }, identity)).toThrow(
      "LOCAL_PILOT_OWNERSHIP_MISMATCH",
    );
    await expect(writeOwnershipMarker(directory, identity)).rejects.toThrow(
      "LOCAL_PILOT_TARGET_ALREADY_EXISTS",
    );
  });

  it("removes only an exact owned temporary directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lo-pilot-owner-parent-"));
    cleanup.push(parent);
    const owned = join(parent, "lo-pilot-run-0123456789abcdef");
    const identity = buildRunIdentity({
      runId: "0123456789abcdef",
      sourceSha: "d".repeat(40),
      creatorPid: process.pid,
    });
    await writeOwnershipMarker(owned, identity);
    await removeOwnedDirectory({ directory: owned, expectedParent: parent, identity });
    await expect(stat(owned)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(removeOwnedDirectory({ directory: parent, expectedParent: parent, identity })).rejects.toThrow(
      "LOCAL_PILOT_DELETE_SCOPE_INVALID",
    );
  });

  it("refuses cleanup when the marker loses owner-only mode", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lo-pilot-owner-parent-"));
    cleanup.push(parent);
    const identity = buildRunIdentity({
      runId: "9999999999999999",
      sourceSha: "9".repeat(40),
      creatorPid: process.pid,
    });
    const directory = join(parent, `lo-pilot-run-${identity.runId}`);
    const markerPath = await writeOwnershipMarker(directory, identity);
    await chmod(markerPath, 0o644);
    await expect(removeOwnedDirectory({ directory, expectedParent: parent, identity })).rejects.toThrow(
      "LOCAL_PILOT_OWNERSHIP_MARKER_INVALID",
    );
    expect(await readFile(markerPath, "utf8")).toContain(identity.runId);
  });
});
