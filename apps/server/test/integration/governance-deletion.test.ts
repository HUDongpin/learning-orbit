import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { teacherRoomExportContract } from "@learning-orbit/contracts";
import { GovernanceService } from "../../src/modules/governance/governance-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for governance deletion tests");

describe("governance deletion SQL integration", () => {
  it("freezes all surfaces and enqueues eight NULL-room lifecycle jobs", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const teacherId = randomUUID();
    const roomId = randomUUID();
    const novaActorId = randomUUID();
    let deletionJobId: string | undefined;
    try {
      await pool.query("INSERT INTO teacher_account(teacher_id,email) VALUES($1,$2)", [
        teacherId, `governance-${teacherId}@example.test`,
      ]);
      await pool.query(
        `INSERT INTO classroom_room(room_id,room_code_hash,nova_actor_id,teacher_id,topic)
         VALUES($1,decode($2,'hex'),$3,$4,'生態系統')`,
        [roomId, "ab".repeat(32), novaActorId, teacherId],
      );

      const service = new GovernanceService(pool, {
        auditSalt: "integration-audit-salt-0123456789",
      });
      const emptyJsonExport = await service.exportRoom(
        { role: "teacher", teacherId, actorId: teacherId },
        roomId,
        { format: "json" },
      );
      expect(teacherRoomExportContract.parse(JSON.parse(emptyJsonExport.body))).toEqual({
        schemaVersion: 1,
        exportKind: "teacher_room",
        roomId,
        throughRoomSeq: 0,
        events: [],
        artifacts: [],
        projections: [],
        provenance: { artifactSources: [], projectionSources: [] },
      });
      const emptyCsvExport = await service.exportRoom(
        { role: "teacher", teacherId, actorId: teacherId },
        roomId,
        { format: "csv" },
      );
      expect(emptyCsvExport.body).toMatch(/^recordType,json\nmanifest,/u);

      const accepted = await service.requestDeletion(
        { role: "teacher", teacherId, actorId: teacherId },
        roomId,
        { confirmation: `DELETE ${roomId}` },
      );
      deletionJobId = accepted.deletionJobId;
      expect(accepted.status).toBe("queued");

      const manifests = await pool.query<{ surface: string; expected_item_count: number }>(
        `SELECT surface,expected_item_count
           FROM deletion_surface_manifest
          WHERE deletion_job_id=$1
          ORDER BY surface`,
        [deletionJobId],
      );
      expect(manifests.rows).toHaveLength(8);
      expect(manifests.rows.every((row) => Number(row.expected_item_count) === 0)).toBe(true);
      expect(manifests.rows.map((row) => row.surface)).toEqual([
        "agent_runs", "artifacts", "caches", "derivatives",
        "events", "media", "projections", "provider_copies",
      ]);

      await expect(service.deletionStatus(
        { role: "teacher", teacherId, actorId: teacherId },
        deletionJobId,
      )).resolves.toEqual({
        deletionJobId,
        status: "queued",
        nextPollAfterMs: 1000,
        failureCode: null,
      });

      const jobs = await pool.query<{
        room_id: string | null;
        source_event_id: string | null;
        job_type: string;
        payload: { deletionJobId?: string; surface?: string };
      }>(
        `SELECT room_id,source_event_id,job_type,payload
           FROM worker_job
          WHERE payload->>'deletionJobId'=$1
          ORDER BY payload->>'surface'`,
        [deletionJobId],
      );
      expect(jobs.rows).toHaveLength(8);
      expect(jobs.rows.every((row) => (
        row.room_id === null
        && row.source_event_id === null
        && row.job_type === "room.delete-surface.v1"
        && row.payload.deletionJobId === deletionJobId
      ))).toBe(true);
    } finally {
      if (deletionJobId) {
        await pool.query("DELETE FROM worker_job WHERE payload->>'deletionJobId'=$1", [deletionJobId]);
        await pool.query("DELETE FROM deletion_job WHERE deletion_job_id=$1", [deletionJobId]);
      }
      await pool.query("DELETE FROM classroom_room WHERE room_id=$1", [roomId]);
      await pool.query("DELETE FROM teacher_account WHERE teacher_id=$1", [teacherId]);
      await pool.end();
    }
  });
});
