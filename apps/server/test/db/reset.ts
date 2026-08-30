import { Pool } from "pg";

export async function resetBusinessTables(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query(
      `TRUNCATE worker_job_completion, worker_job, outbox_event, room_event,
       auth_session, room_member, classroom_room, magic_link, teacher_account CASCADE`,
    );
  } finally {
    await pool.end();
  }
}
