/* generated; source is JSON Schema */

export type MediaAttachmentView = {
  [k: string]: unknown;
} & {
  mediaId: string;
  kind: "image" | "audio";
  state: "upload_pending" | "uploaded" | "processing" | "ready" | "quarantined" | "failed" | "deleted";
  detectedMime: string | null;
  sizeBytes: number;
  altText: string | null;
  caption: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
};
