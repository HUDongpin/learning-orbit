import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const migrationLockSql = "SELECT pg_advisory_lock(hashtextextended('learning-orbit-migrations-v1', 0))";
const migrationUnlockSql = "SELECT pg_advisory_unlock(hashtextextended('learning-orbit-migrations-v1', 0))";

export function resolveMigrationDirectory(directory: string): string {
  return isAbsolute(directory) ? directory : resolve(repoRoot, directory);
}

export async function runMigrations(connectionString: string, directory: string): Promise<void> {
  const migrationDirectory = resolveMigrationDirectory(directory);
  const migrationFiles = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  let lockHeld = false;

  try {
    await client.query(migrationLockSql);
    lockHeld = true;
    // The pilot bootstrap migration is deliberately gated.  Test databases
    // are detected from their conventional *_test name; a real deployment
    // must opt into an environment explicitly and provision its own approved
    // retention policy rather than inheriting a fixture policy.
    let databaseName = "";
    try {
      databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1));
    } catch {
      // The pg driver will provide the authoritative connection error below;
      // leaving the migration environment empty is the safe default.
    }
    const migrationEnvironment = process.env.LO_MIGRATION_ENV
      ?? (/(^|[_-])test(?:ing)?$/i.test(databaseName) ? "test" : "");
    await client.query(
      "SELECT set_config('learning_orbit.migration_env', $1, false)",
      [migrationEnvironment],
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS learning_orbit_schema_migration (
        migration_id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const migrationId of migrationFiles) {
      await client.query("BEGIN");
      try {
        const alreadyApplied = await client.query(
          "SELECT 1 FROM learning_orbit_schema_migration WHERE migration_id = $1 FOR UPDATE",
          [migrationId],
        );
        if (alreadyApplied.rowCount === 0) {
          await client.query(await readFile(resolve(migrationDirectory, migrationId), "utf8"));
          await client.query(
            "INSERT INTO learning_orbit_schema_migration(migration_id) VALUES($1)",
            [migrationId],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      if (lockHeld) await client.query(migrationUnlockSql);
    } finally {
      client.release();
      await pool.end();
    }
  }
}
