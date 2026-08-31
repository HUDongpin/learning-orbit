import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { buildRunIdentity } from "../../scripts/local-pilot/ownership.mjs";
import { createLocalPilotEvidenceRecorder } from "../../scripts/local-pilot/stage-evidence.mjs";
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
    const commandEvidence = createLocalPilotEvidenceRecorder({ id: "disposable-worktree" });

    const owned = await createDetachedPilotWorktree({
      sourceRepository: source,
      targetParent: runParent,
      identity,
      commandEvidence,
    });
    expect(owned.worktreePath).toBe(join(
      await realpath(runParent),
      `lo-pilot-run-${identity.runId}`,
      "checkout",
    ));
    expect((await readFile(join(owned.worktreePath, "tracked.txt"), "utf8"))).toBe("baseline\n");
    expect((await stat(owned.markerPath)).mode & 0o777).toBe(0o600);
    expect((await execFileAsync("git", ["-C", owned.worktreePath, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe("HEAD");

    await writeFile(join(owned.worktreePath, "derived-output.txt"), "owned output\n");
    await writeFile(join(source, "tracked.txt"), "source drift must survive cleanup\n");
    await expect(removeDetachedPilotWorktree({
      sourceRepository: source,
      targetParent: runParent,
      owned,
      identity,
      commandEvidence,
    })).rejects.toThrow("LOCAL_PILOT_WORKTREE_FINAL_DIRTY");
    await expect(stat(owned.runDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    const listed = parseWorktreePorcelain((await execFileAsync(
      "git", ["-C", source, "worktree", "list", "--porcelain", "-z"],
    )).stdout);
    expect(listed.some((item) => item.path === owned.worktreePath)).toBe(false);
    expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe("source drift must survive cleanup\n");
    expect((await execFileAsync("git", ["-C", source, "status", "--porcelain=v1"])).stdout.trim()).toBe("M tracked.txt");
    expect(commandEvidence.snapshot().commands.length).toBeGreaterThan(0);
    expect(commandEvidence.snapshot().commands.every(({ argv }) => argv[0] === "git")).toBe(true);
    expect(JSON.stringify(commandEvidence.snapshot())).not.toContain(parent);
  });

  it("refuses a mismatched source SHA before registering a worktree", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lo-pilot-worktree-parent-"));
    cleanup.push(parent);
    const sourceInput = join(parent, "source");
    const runParent = join(parent, "runs");
    await mkdir(sourceInput);
    await mkdir(runParent);
    const source = await realpath(sourceInput);
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

  it("removes its exact registration when post-add verification fails", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lo-pilot-worktree-parent-"));
    cleanup.push(parent);
    const sourceInput = join(parent, "source");
    const runParent = join(parent, "runs");
    await mkdir(sourceInput);
    await mkdir(runParent);
    const source = await realpath(sourceInput);
    const sha = "a".repeat(40);
    const identity = buildRunIdentity({
      runId: "1122334455667788",
      sourceSha: sha,
      creatorPid: process.pid,
    });
    const worktreePath = join(
      await realpath(runParent),
      `lo-pilot-run-${identity.runId}`,
      "checkout",
    );
    let registered = false;
    const calls: string[] = [];
    const runCommand = async (cwd: string, argv: string[]) => {
      calls.push(`${cwd}\0${argv.join("\0")}`);
      if (argv.join(" ") === "rev-parse HEAD") {
        return { stdout: cwd === source ? `${sha}\n` : `${"b".repeat(40)}\n` };
      }
      if (argv.join(" ") === "status --porcelain=v1 -z") return { stdout: "" };
      if (argv.join(" ") === "worktree add --detach " + worktreePath + " " + sha) {
        registered = true;
        return { stdout: "" };
      }
      if (argv.join(" ") === "rev-parse --abbrev-ref HEAD") return { stdout: "HEAD\n" };
      if (argv.join(" ") === "worktree list --porcelain -z") {
        const sourceRecord = `worktree ${source}\0HEAD ${sha}\0branch refs/heads/main\0\0`;
        const ownedRecord = registered
          ? `worktree ${worktreePath}\0HEAD ${sha}\0detached\0\0`
          : "";
        return { stdout: sourceRecord + ownedRecord };
      }
      if (argv.join(" ") === "worktree remove --force " + worktreePath) {
        registered = false;
        return { stdout: "" };
      }
      throw new Error(`unexpected command ${argv.join(" ")}`);
    };

    await expect(createDetachedPilotWorktree({
      sourceRepository: source,
      targetParent: runParent,
      identity,
      runCommand,
    })).rejects.toThrow("LOCAL_PILOT_WORKTREE_REGISTRATION_MISMATCH");
    expect(registered).toBe(false);
    expect(calls.some((call) => call.includes(`worktree\0remove\0--force\0${worktreePath}`))).toBe(true);
    await expect(stat(join(runParent, `lo-pilot-run-${identity.runId}`)))
      .rejects.toMatchObject({ code: "ENOENT" });
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

  it("validates owner-only marker mode before destructive worktree removal", async () => {
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
      runId: "cafebabecafebabe",
      sourceSha: stdout.trim(),
      creatorPid: process.pid,
    });
    const owned = await createDetachedPilotWorktree({
      sourceRepository: source,
      targetParent: runParent,
      identity,
    });
    await chmod(owned.markerPath, 0o644);
    let destructiveRemoveCalled = false;
    const runCommand = async (cwd: string, argv: string[]) => {
      if (argv[0] === "worktree" && argv[1] === "remove") destructiveRemoveCalled = true;
      return execFileAsync("git", ["-C", cwd, ...argv], { encoding: "utf8" });
    };

    await expect(removeDetachedPilotWorktree({
      sourceRepository: source,
      targetParent: runParent,
      owned,
      identity,
      runCommand,
    })).rejects.toThrow("LOCAL_PILOT_OWNERSHIP_MARKER_INVALID");
    expect(destructiveRemoveCalled).toBe(false);
    expect(await readFile(join(owned.worktreePath, "tracked.txt"), "utf8")).toBe("baseline\n");
  });
});
