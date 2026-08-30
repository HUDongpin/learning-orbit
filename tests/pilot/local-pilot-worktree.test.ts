import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { buildRunIdentity } from "../../scripts/local-pilot/ownership.mjs";
import {
  createDetachedPilotWorktree,
  parseWorktreePorcelain,
  removeDetachedPilotWorktree,
} from "../../scripts/local-pilot/worktree.mjs";

const execFileAsync = promisify(execFile);

describe("disposable detached pilot worktree", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("parses NUL-delimited worktree records without whitespace ambiguity", () => {
    const records = parseWorktreePorcelain(
      "worktree /tmp/source\u0000HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\u0000branch refs/heads/main\u0000\u0000"
      + "worktree /tmp/run checkout\u0000HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\u0000detached\u0000\u0000",
    );
    expect(records).toEqual([
      { path: "/tmp/source", sha: "a".repeat(40), branch: "refs/heads/main", detached: false },
      { path: "/tmp/run checkout", sha: "b".repeat(40), branch: null, detached: true },
    ]);
    expect(() => parseWorktreePorcelain("worktree /tmp/x\u0000HEAD short\u0000\u0000")).toThrow(
      "LOCAL_PILOT_WORKTREE_LIST_INVALID",
    );
  });

  it("creates, verifies, and removes only its exact detached checkout", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lo-pilot-worktree-parent-"));
    cleanup.push(parent);
    const source = join(parent, "source repository");
    const runParent = join(parent, "runs");
    await mkdir(source);
    await mkdir(runParent);
    await execFileAsync("git", ["-C", source, "init", "--quiet"]);
    await execFileAsync("git", ["-C", source, "config", "user.name", "Learning Orbit Test"]);
    await execFileAsync("git", ["-C", source, "config", "user.email", "local-pilot@example.invalid"]);
    await writeFile(join(source, "tracked.txt"), "baseline\n");
    await execFileAsync("git", ["-C", source, "add", "--", "tracked.txt"]);
    await execFileAsync("git", ["-C", source, "commit", "--quiet", "-m", "baseline"]);
    const { stdout } = await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"]);
    const identity = buildRunIdentity({
      runId: "1234567890abcdef",
      sourceSha: stdout.trim(),
      creatorPid: process.pid,
    });

    const owned = await createDetachedPilotWorktree({
      sourceRepository: source,
      targetParent: runParent,
      identity,
    });
    expect(owned.worktreePath).toBe(join(runParent, `lo-pilot-run-${identity.runId}`, "checkout"));
    expect((await readFile(join(owned.worktreePath, "tracked.txt"), "utf8"))).toBe("baseline\n");
    expect((await stat(owned.markerPath)).mode & 0o777).toBe(0o600);
    expect((await execFileAsync("git", ["-C", owned.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe("HEAD");

    await writeFile(join(owned.worktreePath, "derived-output.txt"), "owned output\n");
    await writeFile(join(source, "tracked.txt"), "source drift must survive cleanup\n");
    await removeDetachedPilotWorktree({
      sourceRepository: source,
      targetParent: runParent,
      owned,
      identity,
    });
    await expect(stat(owned.runDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    const listed = parseWorktreePorcelain((await execFileAsync(
      "git", ["-C", source, "worktree", "list", "--porcelain", "-z"],
    )).stdout);
    expect(listed.some((item) => item.path === owned.worktreePath)).toBe(false);
    expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe("source drift must survive cleanup\n");
    expect((await execFileAsync("git", ["-C", source, "status", "--porcelain=v1"])).stdout.trim()).toBe("M tracked.txt");
  });

  it("refuses a mismatched source SHA before registering a worktree", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lo-pilot-worktree-parent-"));
    cleanup.push(parent);
    const source = join(parent, "source");
    const runParent = join(parent, "runs");
    await mkdir(source);
    await mkdir(runParent);
    await execFileAsync("git", ["-C", source, "init", "--quiet"]);
    await execFileAsync("git", ["-C", source, "config", "user.name", "Learning Orbit Test"]);
    await execFileAsync("git", ["-C", source, "config", "user.email", "local-pilot@example.invalid"]);
    await writeFile(join(source, "tracked.txt"), "baseline\n");
    await execFileAsync("git", ["-C", source, "add", "--", "tracked.txt"]);
    await execFileAsync("git", ["-C", source, "commit", "--quiet", "-m", "baseline"]);
    const identity = buildRunIdentity({
      runId: "abcdef1234567890",
      sourceSha: "f".repeat(40),
      creatorPid: process.pid,
    });
    await expect(createDetachedPilotWorktree({
      sourceRepository: source,
      targetParent: runParent,
      identity,
    })).rejects.toThrow("LOCAL_PILOT_SOURCE_SHA_MISMATCH");
  });

  it("never adopts or removes a pre-existing run directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lo-pilot-worktree-parent-"));
    cleanup.push(parent);
    const source = join(parent, "source");
    const runParent = join(parent, "runs");
    await mkdir(source);
    await mkdir(runParent);
    await execFileAsync("git", ["-C", source, "init", "--quiet"]);
    await execFileAsync("git", ["-C", source, "config", "user.name", "Learning Orbit Test"]);
    await execFileAsync("git", ["-C", source, "config", "user.email", "local-pilot@example.invalid"]);
    await writeFile(join(source, "tracked.txt"), "baseline\n");
    await execFileAsync("git", ["-C", source, "add", "--", "tracked.txt"]);
    await execFileAsync("git", ["-C", source, "commit", "--quiet", "-m", "baseline"]);
    const { stdout } = await execFileAsync("git", ["-C", source, "rev-parse", "HEAD"]);
    const identity = buildRunIdentity({
      runId: "0badcafe0badcafe",
      sourceSha: stdout.trim(),
      creatorPid: process.pid,
    });
    const preExisting = join(runParent, `lo-pilot-run-${identity.runId}`);
    await mkdir(preExisting);
    await writeFile(join(preExisting, "owner-data.txt"), "must survive\n");
    await expect(createDetachedPilotWorktree({
      sourceRepository: source,
      targetParent: runParent,
      identity,
    })).rejects.toThrow("LOCAL_PILOT_TARGET_ALREADY_EXISTS");
    expect(await readFile(join(preExisting, "owner-data.txt"), "utf8")).toBe("must survive\n");
  });
});
