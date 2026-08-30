import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/db/migrate.js";
import { lockRoomInTransaction, withRoomSessionLock } from "../../src/modules/rooms/room-lock.js";
import { resetBusinessTables } from "./reset.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required for database integration tests");

const pool = new Pool({ connectionString: url, max: 10 });
const sqlDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/db/sql");
const unlockRoomSessionSql = readFileSync(resolve(sqlDirectory, "unlock_room_session.sql"), "utf8");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

beforeAll(async () => runMigrations(url, "infra/postgres/migrations"));
beforeEach(async () => resetBusinessTables(url));
afterEach(async () => resetBusinessTables(url));
afterAll(async () => pool.end());

describe("canonical database room locks", () => {
  it("serializes the same room but not different rooms", async () => {
    const room = randomUUID();
    const entered = deferred<void>();
    const release = deferred<void>();
    const first = withRoomSessionLock(pool, room, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const secondEntered = deferred<void>();
    const second = withRoomSessionLock(pool, room, async () => { secondEntered.resolve(); });
    const other = withRoomSessionLock(pool, randomUUID(), async () => "independent");
    expect(await other).toBe("independent");
    const stateBeforeRelease = await Promise.race([
      secondEntered.promise.then(() => "entered"),
      new Promise<string>((resolve) => setImmediate(() => resolve("pending"))),
    ]);
    expect(stateBeforeRelease).toBe("pending");
    release.resolve();
    await first;
    await second;
    await secondEntered.promise;
  });

  it("releases a transaction lock on both commit and rollback", async () => {
    const room = randomUUID();
    for (const outcome of ["COMMIT", "ROLLBACK"] as const) {
      const first = await pool.connect();
      try {
        await first.query("BEGIN");
        await lockRoomInTransaction(first, room);
        await first.query(outcome);
      } finally {
        first.release();
      }
      await withRoomSessionLock(pool, room, async () => undefined);
    }
  });

  it("runs callback work on the locked connection and releases in finally after an error", async () => {
    const room = randomUUID();
    let backendPid: number | undefined;
    await expect(withRoomSessionLock(pool, room, async (connection) => {
      backendPid = (await connection.query<{ pg_backend_pid: number }>("SELECT pg_backend_pid()"))
        .rows[0]?.pg_backend_pid;
      throw new Error("CALLBACK_FAILURE");
    })).rejects.toThrow("CALLBACK_FAILURE");
    await withRoomSessionLock(pool, room, async (connection) => {
      expect((await connection.query<{ pg_backend_pid: number }>("SELECT pg_backend_pid()"))
        .rows[0]?.pg_backend_pid).toBeTypeOf("number");
    });
    expect(backendPid).toBeTypeOf("number");
  });

  it("poisons a connection when canonical unlock reports false", async () => {
    const poisonPool = new Pool({ connectionString: url, max: 1 });
    const room = randomUUID();
    let poisonedPid: number | undefined;
    try {
      await expect(withRoomSessionLock(poisonPool, room, async (connection) => {
        poisonedPid = (await connection.query<{ pg_backend_pid: number }>("SELECT pg_backend_pid()"))
          .rows[0]?.pg_backend_pid;
        // Deliberately release the canonical key so the helper's finally block
        // receives PostgreSQL's false result from its own canonical unlock SQL.
        const earlyUnlock = await connection.query<{ pg_advisory_unlock: boolean }>(unlockRoomSessionSql, [room]);
        expect(earlyUnlock.rows[0]?.pg_advisory_unlock).toBe(true);
      })).rejects.toThrow("ROOM_SESSION_UNLOCK_FAILED");
      const replacement = await poisonPool.connect();
      try {
        const replacementPid = (await replacement.query<{ pg_backend_pid: number }>("SELECT pg_backend_pid()"))
          .rows[0]?.pg_backend_pid;
        expect(replacementPid).toBeTypeOf("number");
        expect(replacementPid).not.toBe(poisonedPid);
      } finally {
        replacement.release();
      }
    } finally {
      await poisonPool.end();
    }
  });
});
