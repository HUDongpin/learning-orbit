import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import type { Pool } from "pg";

import { authContract } from "@learning-orbit/contracts";
import { createDatabasePool } from "./db/pool.js";
import { inTransaction } from "./db/transactions.js";

export async function provisionTeacher(pool: Pool, rawEmail: string): Promise<0 | 1> {
  const { email } = authContract.parseTeacherMagicLinkRequest({ email: rawEmail });
  return inTransaction(pool, async (tx) => {
    const result = await tx.query<{ teacher_id: string }>(
      `INSERT INTO teacher_account(email)
       VALUES ($1)
       ON CONFLICT (email) DO NOTHING
       RETURNING teacher_id`,
      [email],
    );
    return result.rowCount === 1 ? 1 : 0;
  });
}

type CliOptions = Readonly<{
  argv?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  stdout?: (text: string) => unknown;
  stderr?: (text: string) => unknown;
  createPool?: (databaseUrl: string) => Pick<Pool, "connect" | "end">;
  provision?: (pool: Pool, email: string) => Promise<0 | 1>;
}>;

export async function runTeacherProvisionCli(options: CliOptions = {}): Promise<0 | 1> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const createPool = options.createPool ?? createDatabasePool;
  const provision = options.provision ?? provisionTeacher;
  let pool: Pick<Pool, "connect" | "end"> | undefined;
  try {
    const commandArgv = argv[0] === "--" ? argv.slice(1) : argv;
    if (commandArgv.length !== 2 || commandArgv[0] !== "--email" || typeof commandArgv[1] !== "string" || commandArgv[1].length === 0) {
      throw new Error("TEACHER_PROVISION_ARGS_INVALID");
    }
    const databaseUrl = env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
    const { email } = authContract.parseTeacherMagicLinkRequest({ email: commandArgv[1] });
    pool = createPool(databaseUrl);
    const inserted = await provision(pool as Pool, email);
    const poolToClose = pool;
    pool = undefined;
    await poolToClose.end();
    stdout(`inserted: ${inserted}\n`);
    return 0;
  } catch {
    if (pool) {
      try { await pool.end(); } catch { /* stable public failure below */ }
    }
    stderr("TEACHER_PROVISION_FAILED\n");
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runTeacherProvisionCli();
}
