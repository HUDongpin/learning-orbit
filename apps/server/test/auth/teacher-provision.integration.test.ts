import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { provisionTeacher, runTeacherProvisionCli } from "../../src/teacher-provision-cli.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("teacher provision PostgreSQL integration", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const email = `pilot-${randomUUID()}@example.invalid`;
  const cliEmail = `pilot-cli-${randomUUID()}@example.invalid`;

  afterAll(async () => {
    await pool.query("DELETE FROM teacher_account WHERE email = ANY($1::text[])", [[email, cliEmail]]);
    await pool.end();
  });

  it("inserts once and returns zero for an exact duplicate", async () => {
    await expect(provisionTeacher(pool, email)).resolves.toBe(1);
    await expect(provisionTeacher(pool, email.toUpperCase())).resolves.toBe(0);
    const result = await pool.query("SELECT count(*)::int AS count FROM teacher_account WHERE email = $1", [email]);
    expect(result.rows[0]?.count).toBe(1);
  });

  it("runs the public CLI path twice with inserted counts 1 then 0", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const options = {
      argv: ["--email", cliEmail],
      env: { DATABASE_URL: databaseUrl },
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
      createPool: (connectionString: string) => new Pool({ connectionString }),
    } as const;
    await expect(runTeacherProvisionCli(options)).resolves.toBe(0);
    await expect(runTeacherProvisionCli(options)).resolves.toBe(0);
    expect(stdout).toEqual(["inserted: 1\n", "inserted: 0\n"]);
    expect(stderr).toEqual([]);
  });
});
