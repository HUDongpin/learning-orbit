import { Pool } from "pg";

export async function resetBusinessTables(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query(
      // security_audit_event has no foreign key to a room - it stores a salted
      // digest, never the room ID - so CASCADE does not reach it and it has to
      // be named, or one suite's decisions leak into the next one's assertions.
      `TRUNCATE security_audit_event, worker_job_completion, worker_job,
       outbox_event, room_event, auth_session, room_member, classroom_room,
       magic_link, teacher_account CASCADE`,
    );
  } finally {
    await pool.end();
  }
}
