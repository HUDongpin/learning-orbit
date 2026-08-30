/* generated; source is JSON Schema */

/**
 * This interface was referenced by `MediaCommandCatalog`'s JSON-Schema
 * via the `definition` "CreateMediaUploadInput".
 */
export type CreateMediaUploadInput = {
  [k: string]: unknown;
};

export interface MediaCommandCatalog {}
/**
 * This interface was referenced by `MediaCommandCatalog`'s JSON-Schema
 * via the `definition` "MediaUploadGrant".
 */
export interface MediaUploadGrant {
  mediaId: string;
  uploadUrl: string;
  requiredHeaders: {
    "x-amz-checksum-sha256": string;
  };
  expiresAt: string;
}
/**
 * This interface was referenced by `MediaCommandCatalog`'s JSON-Schema
 * via the `definition` "MediaDownloadGrant".
 */
export interface MediaDownloadGrant {
  downloadUrl: string;
  expiresAt: string;
}
/**
 * This interface was referenced by `MediaCommandCatalog`'s JSON-Schema
 * via the `definition` "CompleteMediaUploadResponse".
 */
export interface CompleteMediaUploadResponse {
  mediaId: string;
  state: "uploaded" | "processing" | "ready";
  enqueued: boolean;
}
