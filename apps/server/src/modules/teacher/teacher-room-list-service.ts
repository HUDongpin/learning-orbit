import type { Pool } from "pg";

import {
  teacherRoomListContract,
  type AuthSession,
  type TeacherRoomListResponse,
} from "@learning-orbit/contracts";

export class TeacherRoomListError extends Error {
  constructor(readonly code: "ROOM_NOT_FOUND") {
    super(code);
    this.name = "TeacherRoomListError";
  }
}

type RoomRow = Readonly<{
  room_id: string;
  topic: string;
  status: "scheduled" | "open" | "paused" | "closed";
  duration_seconds: number;
  starts_at: Date | null;
  closes_at: Date | null;
  created_at: Date;
}>;

function instant(value: Date | null): string | null {
  if (value === null) return null;
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) {
    throw new Error("ROOM_LIST_ROW_INVALID");
  }
  return value.toISOString();
}

export class TeacherRoomListService {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async list(identity: AuthSession): Promise<TeacherRoomListResponse> {
    if (identity.role !== "teacher") throw new TeacherRoomListError("ROOM_NOT_FOUND");
    const result = await this.pool.query<RoomRow>(
      `SELECT room_id, topic, status, duration_seconds, starts_at, closes_at, created_at
       FROM classroom_room
       WHERE teacher_id = $1
       ORDER BY CASE WHEN status = 'closed' THEN 1 ELSE 0 END ASC, created_at DESC, room_id DESC
       LIMIT 51`,
      [identity.teacherId],
    );
    const truncated = result.rows.length > 50;
    return teacherRoomListContract.parse({
      rooms: result.rows.slice(0, 50).map((row) => ({
        roomId: row.room_id,
        topic: row.topic,
        status: row.status,
        durationSeconds: row.duration_seconds,
        startsAt: instant(row.starts_at),
        closesAt: instant(row.closes_at),
        createdAt: instant(row.created_at),
      })),
      truncated,
    });
  }
}
