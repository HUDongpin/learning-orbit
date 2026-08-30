import { describe, expect, it, vi } from "vitest";

import {
  provisionTeacher,
  runTeacherProvisionCli,
} from "../../src/teacher-provision-cli.js";

function poolReturning(rowCount: number) {
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: null, rows: [] };
    return { rowCount, rows: rowCount ? [{ teacher_id: "00000000-0000-4000-8000-000000000001" }] : [] };
  });
  const release = vi.fn();
  return {
    pool: { connect: vi.fn(async () => ({ query, release })) },
    query,
    release,
  };
}

describe("controlled teacher provisioning", () => {
  it("normalizes with the Magic Link contract and inserts idempotently in a transaction", async () => {
    const first = poolReturning(1);
    await expect(provisionTeacher(first.pool as never, " Teacher@Example.EDU ")).resolves.toBe(1);
    expect(first.query).toHaveBeenCalledWith(expect.stringMatching(
      /INSERT INTO teacher_account\(email\).*ON CONFLICT \(email\) DO NOTHING.*RETURNING teacher_id/s,
    ), ["teacher@example.edu"]);
    expect(first.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      expect.stringContaining("INSERT INTO teacher_account"),
      "COMMIT",
    ]);
    expect(first.release).toHaveBeenCalledTimes(1);

    const duplicate = poolReturning(0);
    await expect(provisionTeacher(duplicate.pool as never, "teacher@example.edu")).resolves.toBe(0);
  });

  it("validates before connecting and rolls back a failed insert before releasing", async () => {
    const connect = vi.fn();
    await expect(provisionTeacher({ connect } as never, "not-an-email")).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();

    const calls: string[] = [];
    const failure = new Error("database secret");
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("INSERT INTO teacher_account")) throw failure;
      return { rowCount: null, rows: [] };
    });
    const release = vi.fn();
    await expect(provisionTeacher({ connect: vi.fn(async () => ({ query, release })) } as never, "teacher@example.edu"))
      .rejects.toBe(failure);
    expect(calls).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      expect.stringContaining("INSERT INTO teacher_account"),
      "ROLLBACK",
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("prints only inserted count for first and duplicate runs", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const end = vi.fn(async () => undefined);
    const createPool = vi.fn(() => ({ end }));
    const provision = vi.fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    await expect(runTeacherProvisionCli({
      argv: ["--", "--email", " Teacher@Example.EDU "],
      env: {
        DATABASE_URL: "postgres://secret.invalid/database",
        TEST_DATABASE_URL: "postgres://must-not-be-used.invalid/database",
      },
      stdout,
      stderr,
      createPool: createPool as never,
      provision,
    })).resolves.toBe(0);
    await expect(runTeacherProvisionCli({
      argv: ["--email", "teacher@example.edu"],
      env: { DATABASE_URL: "postgres://secret.invalid/database" },
      stdout,
      stderr,
      createPool: createPool as never,
      provision,
    })).resolves.toBe(0);
    expect(stdout.mock.calls.flat()).toEqual(["inserted: 1\n", "inserted: 0\n"]);
    expect(stderr).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(2);
    expect(createPool).toHaveBeenNthCalledWith(1, "postgres://secret.invalid/database");
    expect(provision).toHaveBeenNthCalledWith(1, expect.anything(), "teacher@example.edu");
    expect(stdout.mock.calls.flat().join("")).not.toContain("teacher@example.edu");
    expect(stdout.mock.calls.flat().join("")).not.toContain("postgres://");
  });

  it("fails closed for missing database, invalid email, unknown args, and database errors", async () => {
    const cases = [
      { argv: ["--email", "teacher@example.edu"], env: {} },
      { argv: [], env: { DATABASE_URL: "postgres://secret.invalid/database" } },
      { argv: ["--email"], env: { DATABASE_URL: "postgres://secret.invalid/database" } },
      { argv: ["--email", ""], env: { DATABASE_URL: "postgres://secret.invalid/database" } },
      { argv: ["--email", "not-an-email"], env: { DATABASE_URL: "postgres://secret.invalid/database" } },
      { argv: ["--unknown", "teacher@example.edu"], env: { DATABASE_URL: "postgres://secret.invalid/database" } },
      { argv: ["--email", "teacher@example.edu", "extra"], env: { DATABASE_URL: "postgres://secret.invalid/database" } },
      { argv: ["--email", "teacher@example.edu", "--email", "teacher@example.edu"], env: { DATABASE_URL: "postgres://secret.invalid/database" } },
    ];
    for (const input of cases) {
      const stdout = vi.fn();
      const stderr = vi.fn();
      const createPool = vi.fn();
      const provision = vi.fn();
      await expect(runTeacherProvisionCli({
        ...input,
        stdout,
        stderr,
        createPool: createPool as never,
        provision,
      })).resolves.toBe(1);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr.mock.calls).toEqual([["TEACHER_PROVISION_FAILED\n"]]);
      expect(createPool).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
    }

    const stdout = vi.fn();
    const stderr = vi.fn();
    const end = vi.fn(async () => undefined);
    await expect(runTeacherProvisionCli({
      argv: ["--email", "teacher@example.edu"],
      env: { DATABASE_URL: "postgres://secret.invalid/database" },
      stdout,
      stderr,
      createPool: vi.fn(() => ({ end })) as never,
      provision: vi.fn(async () => { throw new Error("database URL and teacher@example.edu"); }),
    })).resolves.toBe(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith("TEACHER_PROVISION_FAILED\n");
    expect(stderr.mock.calls.flat().join("")).not.toContain("teacher@example.edu");
    expect(stderr.mock.calls.flat().join("")).not.toContain("postgres://");
  });

  it("attempts pool shutdown exactly once when shutdown itself fails", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const end = vi.fn(async () => { throw new Error("postgres://secret.invalid teacher@example.edu"); });
    await expect(runTeacherProvisionCli({
      argv: ["--email", "teacher@example.edu"],
      env: { DATABASE_URL: "postgres://secret.invalid/database" },
      stdout,
      stderr,
      createPool: vi.fn(() => ({ end })) as never,
      provision: vi.fn(async () => 1),
    })).resolves.toBe(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("TEACHER_PROVISION_FAILED\n");
    expect(stderr.mock.calls.flat().join("")).not.toMatch(/teacher@example\.edu|postgres:\/\//);
  });
});
