const ROOM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isRoomId(value: string): boolean {
  return ROOM_ID_PATTERN.test(value);
}

export function roomPagePath(roomId: string, role: "student" | "teacher"): string {
  if (!isRoomId(roomId)) throw new Error("INVALID_ROOM_ID");
  return `/session/${roomId}${role === "teacher" ? "/teacher" : ""}`;
}
