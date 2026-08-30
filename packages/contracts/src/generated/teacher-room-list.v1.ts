/* generated; source is JSON Schema */

export interface TeacherRoomListResponse {
  /**
   * @maxItems 50
   */
  rooms: {
    roomId: string;
    topic: string;
    status: "scheduled" | "open" | "paused" | "closed";
    durationSeconds: 2700;
    startsAt: string | null;
    closesAt: string | null;
    createdAt: string;
  }[];
  truncated: boolean;
}
