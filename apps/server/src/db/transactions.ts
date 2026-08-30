import type { Pool, PoolClient } from "pg";

export async function inTransaction<T>(pool: Pool, work: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original error remains the useful failure for callers.
    }
    throw error;
  } finally {
    client.release();
  }
}
