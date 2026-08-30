/* generated; source is JSON Schema */

export interface MediaStatusFrame {
  type: "media_status";
  mediaId: string;
  state: "uploaded" | "processing" | "ready" | "quarantined" | "failed" | "deleted";
  failureCode: string | null;
  updatedAt: string;
}
