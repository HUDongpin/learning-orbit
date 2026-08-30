import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/db/migrate.js";
import { resetBusinessTables } from "./reset.js";

const url = process.env.TEST_DATABASE_URL;

if (!url) {
  throw new Error("TEST_DATABASE_URL is required for database integration tests");
}

afterEach(async () => resetBusinessTables(url));

describe("core PostgreSQL schema", () => {
  it("creates the frozen core tables idempotently", async () => {
    await runMigrations(url, "infra/postgres/migrations");
    await runMigrations(url, "infra/postgres/migrations");

    const pool = new Pool({ connectionString: url });
    try {
      const result = await pool.query(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = ANY($1)
         ORDER BY table_name`,
        [[
          "teacher_account",
          "magic_link",
          "auth_session",
          "classroom_room",
          "room_member",
          "room_event",
          "outbox_event",
          "worker_job",
          "worker_job_completion",
        ]],
      );
      expect(result.rows.map((row) => row.table_name)).toEqual([
        "auth_session",
        "classroom_room",
        "magic_link",
        "outbox_event",
        "room_event",
        "room_member",
        "teacher_account",
        "worker_job",
        "worker_job_completion",
      ]);
    } finally {
      await pool.end();
    }
  });

  it("persists a non-null correlation ID on every worker job", async () => {
    await runMigrations(url, "infra/postgres/migrations");
    const pool = new Pool({ connectionString: url });
    try {
      const column = await pool.query(
        `SELECT is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'worker_job'
           AND column_name = 'correlation_id'`,
      );
      expect(column.rows[0]).toMatchObject({ is_nullable: "NO" });
      expect(column.rows[0]?.column_default).toMatch(/gen_random_uuid/);
      const job = await pool.query(
        `INSERT INTO worker_job(job_type, dedupe_key, payload)
         VALUES ('schema.probe.v1', $1, '{}')
         RETURNING correlation_id`,
        [`schema.probe:${randomUUID()}`],
      );
      expect(job.rows[0]?.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await pool.end();
    }
  });

  it("requires a fenced lease only while a worker job is running", async () => {
    await runMigrations(url, "infra/postgres/migrations");
    const pool = new Pool({ connectionString: url });
    try {
      await expect(
        pool.query(
          `INSERT INTO worker_job(job_type, dedupe_key, payload, status, locked_at, locked_by)
           VALUES ('schema.probe.v1', $1, '{}', 'running', now(), 'worker-a')`,
          [`bad-lease:${randomUUID()}`],
        ),
      ).rejects.toThrow(/worker_job_lease_check/);
      const job = await pool.query(
        `INSERT INTO worker_job(job_type, dedupe_key, payload)
         VALUES ('schema.probe.v1', $1, '{}')
         RETURNING claim_generation, claim_token, locked_at, locked_by`,
        [`clean-lease:${randomUUID()}`],
      );
      expect(job.rows[0]).toEqual({
        claim_generation: "0",
        claim_token: null,
        locked_at: null,
        locked_by: null,
      });
    } finally {
      await pool.end();
    }
  });

  it("keeps a failed migration unrecorded and serializes concurrent runners", async () => {
    await runMigrations(url, "infra/postgres/migrations");
    const pool = new Pool({ connectionString: url });
    const directory = await mkdtemp(join(tmpdir(), "learning-orbit-migrations-"));
    const badMigration = "901_failure_is_unrecorded.sql";
    const goodMigration = "902_concurrent_runner.sql";
    try {
      await writeFile(join(directory, badMigration), "SELECT missing_function_for_migration_test();\n");
      await expect(runMigrations(url, directory)).rejects.toThrow(/missing_function_for_migration_test/);
      const failed = await pool.query(
        "SELECT 1 FROM learning_orbit_schema_migration WHERE migration_id = $1",
        [badMigration],
      );
      expect(failed.rowCount).toBe(0);
      await rm(join(directory, badMigration));
      await writeFile(
        join(directory, goodMigration),
        "CREATE TABLE learning_orbit_concurrent_migration_probe (id integer PRIMARY KEY);\n",
      );
      await Promise.all([runMigrations(url, directory), runMigrations(url, directory)]);
      const applied = await pool.query(
        "SELECT count(*)::text AS count FROM learning_orbit_schema_migration WHERE migration_id = $1",
        [goodMigration],
      );
      expect(applied.rows[0]).toEqual({ count: "1" });
    } finally {
      await pool.query("DROP TABLE IF EXISTS learning_orbit_concurrent_migration_probe");
      await pool.query("DELETE FROM learning_orbit_schema_migration WHERE migration_id = $1", [goodMigration]);
      await rm(directory, { recursive: true, force: true });
      await pool.end();
    }
  });

  it("enforces frozen room, membership, session, event, and completion constraints", async () => {
    await runMigrations(url, "infra/postgres/migrations");
    const pool = new Pool({ connectionString: url });
    const teacherId = randomUUID();
    const roomId = randomUUID();
    try {
      await expect(pool.query(
        "INSERT INTO teacher_account(teacher_id, email) VALUES($1, 'UPPER@example.test')",
        [randomUUID()],
      )).rejects.toThrow();
      await pool.query("INSERT INTO teacher_account(teacher_id, email) VALUES($1, $2)", [teacherId, `teacher-${randomUUID()}@example.test`]);
      await expect(pool.query(
        `INSERT INTO classroom_room(room_id, room_code_hash, nova_actor_id, teacher_id, topic, duration_seconds)
         VALUES($1, decode('aa', 'hex'), $2, $3, 'topic', 1)`,
        [randomUUID(), randomUUID(), teacherId],
      )).rejects.toThrow();
      await pool.query(
        `INSERT INTO classroom_room(room_id, room_code_hash, nova_actor_id, teacher_id, topic)
         VALUES($1, decode($2, 'hex'), $3, $4, 'topic')`,
        [roomId, randomUUID().replaceAll("-", ""), randomUUID(), teacherId],
      );
      await expect(pool.query(
        `INSERT INTO room_member(room_member_id, actor_id, room_id, seat_index, pseudonym, code_hash)
         VALUES($1, $2, $3, 5, '探索者 A', decode('ac', 'hex'))`,
        [randomUUID(), randomUUID(), roomId],
      )).rejects.toThrow();
      await expect(pool.query(
        `INSERT INTO auth_session(session_id, token_hash, principal_kind, teacher_id, expires_at)
         VALUES($1, decode('ad', 'hex'), 'student', $2, now() + interval '1 hour')`,
        [randomUUID(), teacherId],
      )).rejects.toThrow();
      const event = [randomUUID(), roomId, randomUUID(), randomUUID(), randomUUID()];
      await pool.query(
        `INSERT INTO room_event(event_id, room_id, room_seq, type, actor_id, actor_kind, actor_role, revision,
                                operation, event_time, ingest_time, causation_id, correlation_id, payload)
         VALUES($1, $2, 1, 'message.add.v1', $3, 'human', 'student', 1, 'add', now(), now(), $4, $5, '{}')`,
        event,
      );
      await expect(pool.query(
        `INSERT INTO room_event(event_id, room_id, room_seq, type, actor_id, actor_kind, actor_role, revision,
                                operation, event_time, ingest_time, causation_id, correlation_id, payload)
         VALUES($1, $2, 1, 'message.add.v1', $3, 'human', 'student', 1, 'add', now(), now(), $4, $5, '{}')`,
        [randomUUID(), roomId, randomUUID(), randomUUID(), randomUUID()],
      )).rejects.toThrow();
      const job = await pool.query(
        "INSERT INTO worker_job(job_type, dedupe_key, payload) VALUES('schema.probe.v1', $1, '{}') RETURNING job_id",
        [`completion:${randomUUID()}`],
      );
      await expect(pool.query(
        `INSERT INTO worker_job_completion(job_id, claim_generation, claim_token_hash, completion_code)
         VALUES($1, 1, repeat('A', 64), 'lowercase')`,
        [job.rows[0]?.job_id],
      )).rejects.toThrow();
    } finally {
      await pool.end();
    }
  });
});
