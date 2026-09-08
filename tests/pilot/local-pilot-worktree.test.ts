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
      {
        path: "/tmp/source",
        sha: "a".repeat(40),
        branch: "refs/heads/main",
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: "/tmp/run checkout",
        sha: "b".repeat(40),
        branch: null,
        detached: true,
        bare: false,
        locked: false,
        prunable: false,
      },
    ]);
    expect(() => parseWorktreePorcelain("worktree /tmp/x\u0000HEAD short\u0000\u0000")).toThrow(
      "LOCAL_PILOT_WORKTREE_LIST_INVALID",
    );
  });

  // git-worktree(1) emits NUL-separated fields under -z; building fixtures from
  // String.fromCharCode(0) keeps the literal separator out of the source text.
  const NUL = String.fromCharCode(0);
  const porcelain = (...records: string[][]) => (
    records.map((fields) => `${fields.join(NUL)}${NUL}${NUL}`).join("")
  );
  const detachedSha = "1".repeat(40);
  const branchSha = "2".repeat(40);
  const lockedSha = "3".repeat(40);
  const prunableSha = "4".repeat(40);

  it("accepts every worktree attribute git documents, on one listing", () => {
    // This is the shape `git worktree list --porcelain -z` produces on a machine
    // whose repository holds a locked evidence snapshot: locked carries a
    // multi-word reason, prunable carries its own reason, bare carries neither
    // HEAD nor branch, and a -z lock reason is emitted raw so it may contain a
    // newline. None of these belong to the pilot's checkout, and none of them
    // may take the listing down.
    const records = parseWorktreePorcelain(porcelain(
      ["worktree /repos/bare source", "bare"],
      ["worktree /repos/main", `HEAD ${branchSha}`, "branch refs/heads/main"],
      ["worktree /repos/run checkout", `HEAD ${detachedSha}`, "detached"],
      [
        "worktree /repos/evidence snapshot",
        `HEAD ${lockedSha}`,
        "detached",
        "locked read-only evidence snapshot; receipt archived outside worktrees",
      ],
      ["worktree /repos/locked no reason", `HEAD ${lockedSha}`, "branch refs/heads/held", "locked"],
      [
        "worktree /repos/stale",
        `HEAD ${prunableSha}`,
        "detached",
        "prunable gitdir file points to non-existent location",
      ],
    ));
    expect(records).toEqual([
      { path: "/repos/bare source", sha: null, branch: null, detached: false, bare: true, locked: false, prunable: false },
      { path: "/repos/main", sha: branchSha, branch: "refs/heads/main", detached: false, bare: false, locked: false, prunable: false },
      { path: "/repos/run checkout", sha: detachedSha, branch: null, detached: true, bare: false, locked: false, prunable: false },
      { path: "/repos/evidence snapshot", sha: lockedSha, branch: null, detached: true, bare: false, locked: true, prunable: false },
      { path: "/repos/locked no reason", sha: lockedSha, branch: "refs/heads/held", detached: false, bare: false, locked: true, prunable: false },
      { path: "/repos/stale", sha: prunableSha, branch: null, detached: true, bare: false, locked: false, prunable: true },
    ]);
    expect(parseWorktreePorcelain(porcelain(
      ["worktree /repos/run", `HEAD ${lockedSha}`, "detached", `locked first line${"\n"}second line`],
    ))[0].locked).toBe(true);
  });

  it("still fails closed on any porcelain shape git does not document", () => {
    const invalid: Record<string, string> = {
      // A future Git attribute must stop the run, never be skipped past the
      // registration checks that read this record.
      "unknown attribute": porcelain(["worktree /a", `HEAD ${detachedSha}`, "detached", "worktreeconfig"]),
      "unknown attribute with a value": porcelain(["worktree /a", `HEAD ${detachedSha}`, "detached", "refname refs/x"]),
      "value on a boolean label": porcelain(["worktree /a", `HEAD ${detachedSha}`, "detached yes"]),
      "boolean label where a value is required": porcelain(["worktree /a", "HEAD", "detached"]),
      "bare record carrying a checkout": porcelain(["worktree /a", "bare", `HEAD ${detachedSha}`]),
      "attribute outside any record": `locked${NUL}${porcelain(["worktree /a", `HEAD ${detachedSha}`, "detached"])}`,
      "second worktree inside a record": porcelain(["worktree /a", "worktree /b", `HEAD ${detachedSha}`, "detached"]),
      "repeated attribute": porcelain(["worktree /a", `HEAD ${detachedSha}`, "detached", "locked", "locked why"]),
      "branch and detached together": porcelain(["worktree /a", `HEAD ${detachedSha}`, "detached", "branch refs/heads/x"]),
      "empty reason": porcelain(["worktree /a", `HEAD ${detachedSha}`, "detached", "locked "]),
      "relative worktree path": porcelain(["worktree a", `HEAD ${detachedSha}`, "detached"]),
      "stream not NUL terminated": porcelain(["worktree /a", `HEAD ${detachedSha}`, "detached"]).slice(0, -2),
      "empty listing": "",
    };
    for (const [label, text] of Object.entries(invalid)) {
      expect(() => parseWorktreePorcelain(text), label).toThrow("LOCAL_PILOT_WORKTREE_LIST_INVALID");
    }
  });

  it("parses the porcelain this machine's git actually emits", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lo-pilot-worktree-parent-"));
    cleanup.push(parent);
    const source = join(parent, "source");
    await mkdir(source);
    await execFileAsync("git", ["-C", source, "init", "--quiet"]);
    await execFileAsync("git", ["-C", source, "config", "user.name", "Learning Orbit Test"]);
    await execFileAsync("git", ["-C", source, "config", "user.email", "local-pilot@example.invalid"]);
    await writeFile(join(source, "tracked.txt"), "baseline\n");
    await execFileAsync("git", ["-C", source, "add", "--", "tracked.txt"]);
    await execFileAsync("git", ["-C", source, "commit", "--quiet", "-m", "baseline"]);
    const held = join(parent, "held");
    const branched = join(parent, "branched");
    const stale = join(parent, "stale");
    await execFileAsync("git", ["-C", source, "worktree", "add", "--detach", "--quiet", held, "HEAD"]);
    await execFileAsync("git", ["-C", source, "worktree", "add", "--quiet", "-b", "side", branched]);
    await execFileAsync("git", ["-C", source, "worktree", "add", "--detach", "--quiet", stale, "HEAD"]);
    await execFileAsync("git", [
      "-C", source, "worktree", "lock", "--reason", "read-only evidence snapshot", held,
    ]);
    await rm(stale, { recursive: true, force: true });
    const listing = parseWorktreePorcelain((await execFileAsync(
      "git", ["-C", source, "worktree", "list", "--porcelain", "-z"], { encoding: "utf8" },
    )).stdout);
    const byName = (name: string) => {
      const record = listing.find((item: { path: string }) => item.path.endsWith(`/${name}`));
      expect(record, name).toBeDefined();
      return record;
    };
    expect(byName("held")).toMatchObject({ detached: true, locked: true, bare: false, branch: null });
    expect(byName("branched")).toMatchObject({ detached: false, locked: false, branch: "refs/heads/side" });
    expect(byName("stale")).toMatchObject({ detached: true, prunable: true, locked: false });
    expect(byName("source")).toMatchObject({ detached: false, locked: false, prunable: false, bare: false });

    const bare = join(parent, "bare.git");
    await execFileAsync("git", ["init", "--bare", "--quiet", bare]);
    const bareListing = parseWorktreePorcelain((await execFileAsync(
      "git", ["-C", bare, "worktree", "list", "--porcelain", "-z"], { encoding: "utf8" },
    )).stdout);
    expect(bareListing).toHaveLength(1);
    expect(bareListing[0]).toMatchObject({ bare: true, sha: null, branch: null, detached: false });
  });

  it("refuses a locked or prunable registration of its own checkout by name", async () => {
    // The listing, not Git's own lock enforcement, is what is under test here:
    // the harness must refuse a checkout it could not later delete, and must say
    // which attribute caused the refusal rather than reporting a bare mismatch.
    const attempt = async (ownedRecord: (sha: string) => string[]) => {
      const parent = await mkdtemp(join(tmpdir(), "lo-pilot-worktree-parent-"));
      cleanup.push(parent);
      const sourceInput = join(parent, "source");
      const runParent = join(parent, "runs");
      await mkdir(sourceInput);
      await mkdir(runParent);
      const source = await realpath(sourceInput);
      const sha = "a".repeat(40);
      const identity = buildRunIdentity({
        runId: "9988776655443322",
        sourceSha: sha,
        creatorPid: process.pid,
      });
      const worktreePath = join(await realpath(runParent), `lo-pilot-run-${identity.runId}`, "checkout");
      let registered = false;
      const runCommand = async (cwd: string, argv: string[]) => {
        const command = argv.join(" ");
        if (command === "rev-parse HEAD") return { stdout: `${sha}\n` };
        if (command === "rev-parse --abbrev-ref HEAD") return { stdout: "HEAD\n" };
        if (command === "status --porcelain=v1 -z") return { stdout: "" };
        if (command === `worktree add --detach ${worktreePath} ${sha}`) {
          registered = true;
          return { stdout: "" };
        }
        if (command === `worktree remove --force ${worktreePath}`) {
          registered = false;
          return { stdout: "" };
        }
        if (command === "worktree list --porcelain -z") {
          return {
            stdout: porcelain(
              [`worktree ${source}`, `HEAD ${sha}`, "branch refs/heads/main"],
              ...(registered ? [[`worktree ${worktreePath}`, ...ownedRecord(sha)]] : []),
            ),
          };
        }
        throw new Error(`unexpected command ${command}`);
      };
      const failure = await createDetachedPilotWorktree({
        sourceRepository: source,
        targetParent: runParent,
        identity,
        runCommand,
      }).then(() => null, (error: unknown) => error);
      return { failure, registered, runDirectory: join(runParent, `lo-pilot-run-${identity.runId}`) };
    };

    const locked = await attempt((sha) => [
      `HEAD ${sha}`, "detached", "locked read-only evidence snapshot; do not reuse",
    ]);
    expect((locked.failure as Error).message).toBe("LOCAL_PILOT_WORKTREE_REGISTRATION_LOCKED");
    expect(locked.registered).toBe(false);
    await expect(stat(locked.runDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    const prunable = await attempt((sha) => [
      `HEAD ${sha}`, "detached", "prunable gitdir file points to non-existent location",
    ]);
    expect((prunable.failure as Error).message).toBe("LOCAL_PILOT_WORKTREE_REGISTRATION_PRUNABLE");
    expect(prunable.registered).toBe(false);

    const bare = await attempt(() => ["bare"]);
    expect((bare.failure as Error).message).toBe("LOCAL_PILOT_WORKTREE_REGISTRATION_BARE");
    expect(bare.registered).toBe(false);
  });

  it("reports the setup failure code when cleanup cannot prove the registration absent", async () => {
    const parent = await mkdtemp(join(tmpdir(), "lo-pilot-worktree-parent-"));
    cleanup.push(parent);
    const sourceInput = join(parent, "source");
    const runParent = join(parent, "runs");
    await mkdir(sourceInput);
    await mkdir(runParent);
    const source = await realpath(sourceInput);
    const sha = "a".repeat(40);
    const identity = buildRunIdentity({
      runId: "5566778899aabbcc",
      sourceSha: sha,
      creatorPid: process.pid,
    });
    const runDirectory = join(await realpath(runParent), `lo-pilot-run-${identity.runId}`);
    const worktreePath = join(runDirectory, "checkout");
    let listings = 0;
    const runCommand = async (cwd: string, argv: string[]) => {
      const command = argv.join(" ");
      if (command === "rev-parse HEAD") {
        // The checkout reports a different SHA, so setup fails on the mismatch.
        return { stdout: cwd === source ? `${sha}\n` : `${"b".repeat(40)}\n` };
      }
      if (command === "rev-parse --abbrev-ref HEAD") return { stdout: "HEAD\n" };
      if (command === "status --porcelain=v1 -z") return { stdout: "" };
      if (command === `worktree add --detach ${worktreePath} ${sha}`) return { stdout: "" };
      if (command === "worktree list --porcelain -z") {
        listings += 1;
        // The cleanup path re-reads this listing. When that read is the thing
        // that is broken, the setup failure must survive it.
        if (listings > 1) return { stdout: "not a porcelain listing" };
        return {
          stdout: porcelain(
            [`worktree ${source}`, `HEAD ${sha}`, "branch refs/heads/main"],
            [`worktree ${worktreePath}`, `HEAD ${sha}`, "detached"],
          ),
        };
      }
      throw new Error(`unexpected command ${command}`);
    };
    const evidence = createLocalPilotEvidenceRecorder({ id: "cleanup-code" });
    const failure = await evidence.runCheck("detached-worktree", () => createDetachedPilotWorktree({
      sourceRepository: source,
      targetParent: runParent,
      identity,
      runCommand,
    })).then(() => null, (error: unknown) => error);

    expect((failure as Error).message).toBe(
      "LOCAL_PILOT_WORKTREE_REGISTRATION_MISMATCH LOCAL_PILOT_WORKTREE_SETUP_CLEANUP_FAILED",
    );
    expect(((failure as Error).cause as Error).message).toBe("LOCAL_PILOT_WORKTREE_REGISTRATION_MISMATCH");
    // The receipt names the cause instead of the cleanup that could not run.
    expect(evidence.snapshot().checks[0].failureCode).toBe("LOCAL_PILOT_WORKTREE_REGISTRATION_MISMATCH");
    // Bytes stay put while Git metadata for that path might still exist.
    expect((await stat(runDirectory)).isDirectory()).toBe(true);
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
