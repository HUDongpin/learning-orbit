export type StoreCallControl = Readonly<{
  signal: AbortSignal;
  deadline: Date;
  /** Optional injected clock used by deterministic tests and bounded adapters. */
  now?: () => Date;
}>;

export interface MediaStoreCapabilities {
  readonly maxPresignMs: number;
  readonly maxUploadRequestMs: number;
  readonly maxSignerDbClockSkewMs: number;
  readonly maxPostAbortSettlementMs: number;
  readonly exactKeyHeadIsStronglyConsistent: boolean;
  readonly strongChecksumHead: boolean;
  readonly conditionalPromotion: boolean;
  readonly writeOnceDestination: boolean;
}

export interface MediaStore {
  readonly capabilities: MediaStoreCapabilities;
  createUploadUrl(
    input: {
      objectKey: string;
      mime: string;
      sizeBytes: number;
      checksumSha256Base64: string;
      expiresSeconds: number;
    },
    control: StoreCallControl,
  ): Promise<{
    url: string;
    requiredHeaders: { "x-amz-checksum-sha256": string };
    signedAt: Date;
    expiresAt: Date;
  }>;
  promoteStagingObject(
    input: {
      stagingKey: string;
      destinationKey: string;
      sourceEtag: string;
      expectedSha256: string;
      ifDestinationAbsent: true;
    },
    control: StoreCallControl,
  ): Promise<"created" | "already_present_same_hash">;
  createDownloadUrl(
    input: { objectKey: string; expiresSeconds: number },
    control: StoreCallControl,
  ): Promise<string>;
  stat(
    objectKey: string,
    control: StoreCallControl,
  ): Promise<{
    objectKey: string;
    sizeBytes: number;
    sha256: string;
    detectedMime: string;
    etag: string;
  }>;
  deleteObjects(objectKeys: string[], control: StoreCallControl): Promise<void>;
}

export function assertStoreCallControl(control: StoreCallControl): void {
  // `AbortSignal` may come from another realm (for example a browser-like
  // test harness), so use its stable structural contract rather than an
  // `instanceof` check that would reject an otherwise valid signal.
  if (!control?.signal
    || typeof (control.signal as { aborted?: unknown }).aborted !== "boolean"
    || !(control.deadline instanceof Date)
    || !Number.isFinite(control.deadline.getTime())) {
    throw new Error("STORE_CALL_CONTROL_REQUIRED");
  }
  const current = control.now?.() ?? new Date();
  if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw new Error("STORE_CALL_CONTROL_REQUIRED");
  if (control.signal.aborted || control.deadline.getTime() <= current.getTime()) {
    throw new Error("STORE_DEADLINE_EXCEEDED");
  }
}

export function hexSha256ToBase64(hex: string): string {
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error("INVALID_SHA256");
  return Buffer.from(hex, "hex").toString("base64");
}

export function maxDate(...dates: readonly Date[]): Date {
  if (dates.length === 0) throw new Error("NO_DATES");
  const max = Math.max(...dates.map((date) => date.getTime()));
  if (!Number.isFinite(max)) throw new Error("INVALID_DATE");
  return new Date(max);
}
