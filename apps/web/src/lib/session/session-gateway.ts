import {
  apiErrorContract,
  agentContract,
  analyticsContract,
  analyticsHttpContract,
  analyticsTeacherHttpContract,
  authContract,
  deletionLifecycleContract,
  mediaAttachmentContract,
  mediaCommandContract,
  roomHttpContract,
  routes,
  teacherRoomListContract,
  teacherRoomExportContract,
  type ApiError,
  type AgentCurrentState,
  type AgentSettingsInput,
  type AgentSettingsResponse,
  type AnalyticsPatchPage,
  type AnalyticsReviewAccepted,
  type AnalyticsReviewCommand,
  type AnalyticsReviewDetail,
  type AnalyticsResyncResponse,
  type AnalyticsTimelineResponse,
  type AuthSession,
  type ConceptMapSnapshot,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type CompleteMediaUploadResponse,
  type CreateMediaUploadInput,
  type DerivedTextArtifact,
  type DerivedTextArtifactPage,
  type DeleteRoomAccepted,
  type DeletionStatus,
  type JoinRoomRequest,
  type MediaAttachmentView,
  type MediaDownloadGrant,
  type MediaUploadGrant,
  type RoomDetails,
  type RoomEventPage,
  type SnaProjectionBundle,
  type TeacherMagicLinkAccepted,
  type TeacherMagicLinkRequest,
  type TeacherRoomListResponse,
} from "@learning-orbit/contracts";
import type { ProjectionFrame } from "@learning-orbit/contracts";

type FetchLike = typeof globalThis.fetch;
export type ProjectionKey = ProjectionFrame["projectionKey"];
export type EchoProjectionKey = Extract<ProjectionKey, `echo.${string}`>;
export type ProjectionSnapshot = ConceptMapSnapshot | SnaProjectionBundle;
type AnalyticsRequestOptions = Readonly<{ signal?: AbortSignal }>;
export type DerivedTextArtifactQuery = Readonly<{
  reviewStatus?: DerivedTextArtifact["reviewStatus"];
  afterArtifactId?: string;
  includeHistory?: boolean;
  limit?: number;
}>;
export type RoomExportFormat = "json" | "csv";
export type RoomExportFile = Readonly<{
  blob: Blob;
  fileName: string;
  format: RoomExportFormat;
}>;

export interface SessionGateway {
  getSession(): Promise<AuthSession>;
  joinStudent(input: JoinRoomRequest): Promise<Extract<AuthSession, { role: "student" }>>;
  requestTeacherMagicLink(input: TeacherMagicLinkRequest): Promise<TeacherMagicLinkAccepted>;
  getTeacherRooms(): Promise<TeacherRoomListResponse>;
  createRoom(input: CreateRoomRequest): Promise<CreateRoomResponse>;
  getRoom(roomId: string): Promise<RoomDetails>;
  getRoomEvents(roomId: string, afterSeq: number, limit?: number): Promise<RoomEventPage>;
  createMediaUpload(roomId: string, input: CreateMediaUploadInput): Promise<MediaUploadGrant>;
  completeMediaUpload(roomId: string, mediaId: string): Promise<CompleteMediaUploadResponse>;
  getMedia(roomId: string, mediaId: string): Promise<MediaAttachmentView>;
  getMediaDownloadGrant(roomId: string, mediaId: string): Promise<MediaDownloadGrant>;
  getAgentCurrent(roomId: string, options?: Readonly<{ signal?: AbortSignal }>): Promise<AgentCurrentState>;
  setAgentSettings(roomId: string, input: AgentSettingsInput, options?: AnalyticsRequestOptions): Promise<AgentSettingsResponse>;
  getDerivedTextArtifacts(roomId: string, query?: DerivedTextArtifactQuery, options?: AnalyticsRequestOptions): Promise<DerivedTextArtifactPage>;
  submitAnalyticsReview(roomId: string, input: AnalyticsReviewCommand, options?: AnalyticsRequestOptions): Promise<AnalyticsReviewAccepted>;
  getAnalyticsReviewDetail(roomId: string, reviewEventId: string, options?: AnalyticsRequestOptions): Promise<AnalyticsReviewDetail>;
  requestRoomDeletion(roomId: string, options?: AnalyticsRequestOptions): Promise<DeleteRoomAccepted>;
  getDeletionStatus(deletionJobId: string, options?: AnalyticsRequestOptions): Promise<DeletionStatus>;
  getRoomDeletion(roomId: string, options?: AnalyticsRequestOptions): Promise<DeletionStatus>;
  exportRoom(roomId: string, format: RoomExportFormat, options?: AnalyticsRequestOptions): Promise<RoomExportFile>;
  getProjectionLatest(roomId: string, projectionKey: ProjectionKey, options?: AnalyticsRequestOptions): Promise<ProjectionSnapshot>;
  getProjectionPatches(roomId: string, projectionKey: EchoProjectionKey, query: Readonly<{ analysisEpoch: string; afterProjectionVersion?: number }>, options?: AnalyticsRequestOptions): Promise<AnalyticsPatchPage>;
  getConceptTimeline(roomId: string, projectionKey: EchoProjectionKey, query: Readonly<{ analysisEpoch: string; limit?: number }>, options?: AnalyticsRequestOptions): Promise<AnalyticsTimelineResponse>;
  logout(): Promise<void>;
}

export class SessionGatewayError extends Error {
  constructor(readonly code: ApiError["code"] | AnalyticsResyncResponse["code"] | "SESSION_NETWORK_FAILURE" | "SESSION_RESPONSE_INVALID" | "SESSION_IDENTITY_MISMATCH") {
    super(code);
    this.name = "SessionGatewayError";
  }
}

const ANALYTICS_ERROR_ALLOWLIST = {
  400: ["INVALID_ANALYTICS_QUERY"],
  401: ["AUTH_REQUIRED"],
  403: ["PROJECTION_FORBIDDEN", "STUDENT_ANALYTICS_NOT_PROMOTED"],
  404: ["ROOM_NOT_FOUND", "PROJECTION_NOT_FOUND", "ANALYTICS_NOT_READY"],
  410: ["ROOM_DELETION_IN_PROGRESS", "RETENTION_POLICY_EXPIRED"],
  500: ["INTERNAL"],
  503: ["ANALYTICS_CORRUPT"],
} as const satisfies Readonly<Record<number, readonly ApiError["code"][]>>;
const EXPORT_MAX_BYTES = 32 * 1024 * 1024;
const EXPORT_MAX_RECORDS = 30_015;
const EXPORT_CSV_HEADER = "recordType,json\n";
const SAFE_EXPORT_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const IDENTIFIER_BEARING_FILE_NAME = /(?:^|[-_])[0-9a-f]{8,}(?=[-_.]|$)/iu;

function exactUtf8ContentType(value: string | null, expected: "application/json" | "text/csv"): boolean {
  if (!value) return false;
  const parts = value.split(";").map((part) => part.trim());
  if (parts.shift()?.toLowerCase() !== expected) return false;
  return parts.length <= 1
    && (parts.length === 0 || /^charset\s*=\s*utf-8$/iu.test(parts[0] ?? ""));
}

function safeExportFileName(header: string | null, format: RoomExportFormat): string {
  const fallback = `learning-orbit-room-export.${format}`;
  if (!header || !/^attachment(?:\s*;|\s*$)/iu.test(header)) return fallback;
  let candidate: string | undefined;
  const extended = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]+)\s*(?:;|$)/iu.exec(header);
  if (extended?.[1]) {
    try { candidate = decodeURIComponent(extended[1].trim()); }
    catch { return fallback; }
  } else {
    const quoted = /(?:^|;)\s*filename\s*=\s*"([^"\\]*)"\s*(?:;|$)/iu.exec(header);
    const token = /(?:^|;)\s*filename\s*=\s*([^;\s]+)\s*(?:;|$)/iu.exec(header);
    candidate = quoted?.[1] ?? token?.[1];
  }
  if (!candidate || !SAFE_EXPORT_FILE_NAME.test(candidate)
    || candidate.includes("..")
    || !candidate.toLowerCase().endsWith(`.${format}`)
    || IDENTIFIER_BEARING_FILE_NAME.test(candidate)) return fallback;
  return candidate;
}

export async function readBoundedExportText(
  response: Response,
  maxBytes = EXPORT_MAX_BYTES,
): Promise<string> {
  if (!(response instanceof Response) || !Number.isSafeInteger(maxBytes)
    || maxBytes < 1 || maxBytes > EXPORT_MAX_BYTES) return responseInvalid();
  const contentLength = response.headers.get("content-length");
  let declaredLength: number | undefined;
  if (contentLength !== null
    && (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)
      || !Number.isSafeInteger(Number(contentLength))
      || Number(contentLength) > maxBytes)) return responseInvalid();
  if (contentLength !== null) declaredLength = Number(contentLength);
  if (!response.body) {
    if (declaredLength !== undefined && declaredLength !== 0) return responseInvalid();
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // Response bodies may be created by a different browser/JS realm; an
      // `instanceof` check would reject a genuine Uint8Array from that realm.
      if (Object.prototype.toString.call(value) !== "[object Uint8Array]") {
        return responseInvalid();
      }
      total += value.byteLength;
      if (!Number.isSafeInteger(total) || total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return responseInvalid();
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof SessionGatewayError) throw error;
    return responseInvalid();
  } finally {
    reader.releaseLock();
  }
  if (declaredLength !== undefined && total !== declaredLength) return responseInvalid();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return responseInvalid(); }
}

function validateJsonExport(text: string, roomId: string): string {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return responseInvalid(); }
  try {
    const document = teacherRoomExportContract.parse(value);
    if (document.roomId !== roomId) return responseInvalid();
    return teacherRoomExportContract.encode(document);
  } catch { return responseInvalid(); }
}

function parseCsvRecords(text: string): readonly (readonly [string, string])[] {
  if (!text.startsWith(EXPORT_CSV_HEADER) || !text.endsWith("\n") || text.includes("\r")) {
    return responseInvalid();
  }
  const input = text.slice(EXPORT_CSV_HEADER.length);
  const records: Array<readonly [string, string]> = [];
  let row: string[] = [];
  let field = "";
  let fieldStarted = false;
  let quoted = false;
  let afterQuote = false;
  const finishField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
    afterQuote = false;
  };
  const finishRecord = () => {
    finishField();
    if (row.length !== 2 || row[0] === "" || row[1] === "") return responseInvalid();
    records.push([row[0]!, row[1]!]);
    if (records.length > EXPORT_MAX_RECORDS) return responseInvalid();
    row = [];
  };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (afterQuote) {
      if (character === ",") finishField();
      else if (character === "\n") finishRecord();
      else return responseInvalid();
      continue;
    }
    if (character === '"') {
      if (fieldStarted || field !== "") return responseInvalid();
      fieldStarted = true;
      quoted = true;
    } else if (character === ",") {
      finishField();
    } else if (character === "\n") {
      finishRecord();
    } else {
      fieldStarted = true;
      field += character;
    }
  }
  if (quoted || afterQuote || fieldStarted || field !== "" || row.length !== 0) {
    return responseInvalid();
  }
  return records;
}

function validateCsvExport(text: string, roomId: string): string {
  const records = parseCsvRecords(text);
  let manifest: Record<string, unknown> | null = null;
  const events: unknown[] = [];
  const artifacts: unknown[] = [];
  const projections: unknown[] = [];
  const artifactSources: unknown[] = [];
  const projectionSources: unknown[] = [];
  for (const [recordType, encoded] of records) {
    let value: unknown;
    try { value = JSON.parse(encoded); }
    catch { return responseInvalid(); }
    if (recordType === "manifest") {
      if (manifest !== null || !value || typeof value !== "object" || Array.isArray(value)) {
        return responseInvalid();
      }
      manifest = value as Record<string, unknown>;
    } else if (recordType === "event") events.push(value);
    else if (recordType === "artifact") artifacts.push(value);
    else if (recordType === "projection") projections.push(value);
    else if (recordType === "artifact_provenance") artifactSources.push(value);
    else if (recordType === "projection_provenance") projectionSources.push(value);
    else return responseInvalid();
  }
  if (!manifest) return responseInvalid();
  try {
    const document = teacherRoomExportContract.parse({
      schemaVersion: manifest.schemaVersion,
      exportKind: manifest.exportKind,
      roomId: manifest.roomId,
      throughRoomSeq: manifest.throughRoomSeq,
      events,
      artifacts,
      projections,
      provenance: { artifactSources, projectionSources },
    });
    if (document.roomId !== roomId) return responseInvalid();
  } catch { return responseInvalid(); }
  return text;
}

export function normalizeClassroomCode(value: string): string {
  return value.replace(/\s+/gu, "").toUpperCase();
}

function responseInvalid(): never {
  throw new SessionGatewayError("SESSION_RESPONSE_INVALID");
}

async function jsonBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") responseInvalid();
  try {
    return await response.json();
  } catch {
    return responseInvalid();
  }
}

async function legalError(
  response: Response,
  allowlist: Readonly<Record<number, readonly ApiError["code"][]>>,
): Promise<never> {
  let parsed: ApiError;
  try {
    parsed = apiErrorContract.parse(await jsonBody(response));
  } catch {
    return responseInvalid();
  }
  if (!allowlist[response.status]?.includes(parsed.code)) responseInvalid();
  throw new SessionGatewayError(parsed.code);
}

export class FetchSessionGateway implements SessionGateway {
  readonly #fetch: FetchLike;

  constructor(options: Readonly<{ fetch?: FetchLike }> = {}) {
    const fetch = options.fetch ?? globalThis.fetch;
    if (typeof fetch !== "function") throw new SessionGatewayError("SESSION_NETWORK_FAILURE");
    this.#fetch = fetch.bind(globalThis);
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    if (!path.startsWith("/v1/") || path.startsWith("//")) responseInvalid();
    try {
      return await this.#fetch(path, {
        ...init,
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: {
          Accept: "application/json",
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...init.headers,
        },
      });
    } catch {
      throw new SessionGatewayError("SESSION_NETWORK_FAILURE");
    }
  }

  async getSession(): Promise<AuthSession> {
    const response = await this.#request(routes.auth.session(), { method: "GET" });
    if (response.status === 401) return legalError(response, { 401: ["AUTH_REQUIRED"] });
    if (response.status !== 200) responseInvalid();
    try {
      return authContract.parseSession(await jsonBody(response));
    } catch {
      return responseInvalid();
    }
  }

  async joinStudent(input: JoinRoomRequest): Promise<Extract<AuthSession, { role: "student" }>> {
    const request = roomHttpContract.parseJoinRoomRequest({
      roomCode: normalizeClassroomCode(input.roomCode),
      seatCode: normalizeClassroomCode(input.seatCode),
    });
    const response = await this.#request(routes.rooms.join(), {
      method: "POST",
      body: roomHttpContract.encodeJoinRoomRequest(request),
    });
    if (response.status !== 200) {
      return legalError(response, {
        400: ["INVALID_JOIN_REQUEST"],
        403: ["JOIN_FORBIDDEN"],
        429: ["RATE_LIMITED"],
        503: ["ROOM_SERVICE_UNAVAILABLE"],
      });
    }
    let joined;
    try {
      joined = roomHttpContract.parseJoinRoomResponse(await jsonBody(response));
    } catch {
      return responseInvalid();
    }
    const session = await this.getSession();
    if (session.role !== "student" || session.roomMemberId !== joined.roomMemberId
      || session.actorId !== joined.actorId || session.pseudonym !== joined.pseudonym) {
      throw new SessionGatewayError("SESSION_IDENTITY_MISMATCH");
    }
    return session;
  }

  async requestTeacherMagicLink(input: TeacherMagicLinkRequest): Promise<TeacherMagicLinkAccepted> {
    const request = authContract.parseTeacherMagicLinkRequest(input);
    const response = await this.#request(routes.auth.teacherMagicLink(), {
      method: "POST",
      body: JSON.stringify(request),
    });
    if (response.status !== 202) {
      if (response.status === 429) return legalError(response, { 429: ["RATE_LIMITED"] });
      responseInvalid();
    }
    try {
      return authContract.parseTeacherMagicLinkAccepted(await jsonBody(response));
    } catch {
      return responseInvalid();
    }
  }

  async getTeacherRooms(): Promise<TeacherRoomListResponse> {
    const response = await this.#request(routes.teacher.rooms(), { method: "GET" });
    if (response.status !== 200) {
      return legalError(response, {
        401: ["AUTH_REQUIRED"],
        404: ["ROOM_NOT_FOUND"],
        503: ["ROOM_LIST_UNAVAILABLE"],
      });
    }
    try {
      return teacherRoomListContract.parse(await jsonBody(response));
    } catch {
      return responseInvalid();
    }
  }

  async createRoom(input: CreateRoomRequest): Promise<CreateRoomResponse> {
    const request = roomHttpContract.parseCreateRoomRequest(input);
    const response = await this.#request(routes.rooms.create(), {
      method: "POST",
      body: roomHttpContract.encodeCreateRoomRequest(request),
    });
    if (response.status !== 201) {
      return legalError(response, {
        400: ["INVALID_ROOM_REQUEST"],
        401: ["AUTH_REQUIRED"],
        403: ["ROOM_FORBIDDEN"],
        503: ["ROOM_SERVICE_UNAVAILABLE", "ROOM_CODE_UNAVAILABLE", "RETENTION_POLICY_NOT_CONFIGURED"],
      });
    }
    try {
      return roomHttpContract.parseCreateRoomResponse(await jsonBody(response));
    } catch {
      return responseInvalid();
    }
  }

  async getRoom(roomId: string): Promise<RoomDetails> {
    const response = await this.#request(routes.rooms.get(roomId), { method: "GET" });
    if (response.status !== 200) {
      return legalError(response, {
        401: ["AUTH_REQUIRED"],
        404: ["ROOM_NOT_FOUND"],
        410: ["DELETION_IN_PROGRESS"],
        503: ["ROOM_SERVICE_UNAVAILABLE"],
      });
    }
    try {
      return roomHttpContract.parseRoomDetails(await jsonBody(response));
    } catch {
      return responseInvalid();
    }
  }

  async getRoomEvents(roomId: string, afterSeq: number, limit?: number): Promise<RoomEventPage> {
    const path = routes.rooms.events(roomId, { afterSeq, ...(limit === undefined ? {} : { limit }) });
    const response = await this.#request(path, { method: "GET" });
    if (response.status !== 200) {
      return legalError(response, {
        400: ["INVALID_QUERY"],
        401: ["AUTH_REQUIRED"],
        404: ["ROOM_NOT_FOUND"],
        503: ["ROOM_SERVICE_UNAVAILABLE"],
      });
    }
    try {
      return roomHttpContract.parseRoomEventPage(await jsonBody(response));
    } catch {
      return responseInvalid();
    }
  }

  async createMediaUpload(roomId: string, input: CreateMediaUploadInput): Promise<MediaUploadGrant> {
    let body: Record<string, unknown>;
    try { body = mediaCommandContract.parseCreateUpload(input); }
    catch { return responseInvalid(); }
    const response = await this.#request(routes.media.upload(roomId), { method: "POST", body: JSON.stringify(body) });
    if (response.status !== 201) {
      return legalError(response, {
        400: ["INVALID_MEDIA_COMMAND"],
        401: ["AUTH_REQUIRED"],
        404: ["MEDIA_NOT_FOUND"],
        409: ["ROOM_DELETION_IN_PROGRESS", "ROOM_NOT_OPEN"],
        422: ["ALT_REQUIRED", "SIZE_OUT_OF_RANGE"],
        500: ["INTERNAL"],
        503: ["MEDIA_SERVICE_UNAVAILABLE"],
      });
    }
    try { return mediaCommandContract.parseUploadGrant(await jsonBody(response)); }
    catch { return responseInvalid(); }
  }

  async completeMediaUpload(roomId: string, mediaId: string): Promise<CompleteMediaUploadResponse> {
    const response = await this.#request(routes.media.complete(roomId, mediaId), { method: "POST", body: "{}" });
    if (response.status !== 200) {
      return legalError(response, {
        400: ["INVALID_MEDIA_COMMAND"],
        401: ["AUTH_REQUIRED"],
        404: ["MEDIA_NOT_FOUND", "MEDIA_UPLOAD_NOT_FOUND"],
        409: ["MEDIA_UPLOAD_EXPIRED", "MEDIA_UPLOAD_NOT_SETTLED", "MEDIA_QUARANTINED", "MEDIA_FAILED", "MEDIA_DELETED", "ROOM_DELETION_IN_PROGRESS", "ROOM_NOT_OPEN"],
        500: ["INTERNAL"],
        503: ["MEDIA_SERVICE_UNAVAILABLE"],
      });
    }
    try { return mediaCommandContract.parseComplete(await jsonBody(response)); }
    catch { return responseInvalid(); }
  }

  async getMedia(roomId: string, mediaId: string): Promise<MediaAttachmentView> {
    const response = await this.#request(routes.media.get(roomId, mediaId), { method: "GET" });
    if (response.status !== 200) {
      return legalError(response, {
        401: ["AUTH_REQUIRED"],
        404: ["MEDIA_NOT_FOUND"],
        409: ["MEDIA_NOT_READY"],
        500: ["INTERNAL"],
        503: ["MEDIA_SERVICE_UNAVAILABLE"],
      });
    }
    try { return mediaAttachmentContract.parse(await jsonBody(response)); }
    catch { return responseInvalid(); }
  }

  async getMediaDownloadGrant(roomId: string, mediaId: string): Promise<MediaDownloadGrant> {
    const response = await this.#request(routes.media.download(roomId, mediaId), { method: "GET" });
    if (response.status !== 200) {
      return legalError(response, {
        401: ["AUTH_REQUIRED"],
        404: ["MEDIA_NOT_FOUND"],
        409: ["MEDIA_NOT_READY", "MEDIA_QUARANTINED", "MEDIA_FAILED", "MEDIA_DELETED", "ROOM_DELETION_IN_PROGRESS"],
        500: ["INTERNAL"],
        503: ["MEDIA_SERVICE_UNAVAILABLE"],
      });
    }
    try { return mediaCommandContract.parseDownloadGrant(await jsonBody(response)); }
    catch { return responseInvalid(); }
  }

  async getAgentCurrent(roomId: string, options: Readonly<{ signal?: AbortSignal }> = {}): Promise<AgentCurrentState> {
    const response = await this.#request(routes.agent.current(roomId), {
      method: "GET",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status !== 200) {
      return legalError(response, {
        401: ["AUTH_REQUIRED"],
        404: ["ROOM_NOT_FOUND"],
        409: ["ROOM_DELETION_IN_PROGRESS"],
        500: ["INTERNAL"],
        503: ["AGENT_SERVICE_UNAVAILABLE"],
      });
    }
    try {
      const current = agentContract.parseCurrent(await jsonBody(response));
      if (current.roomId !== roomId) return responseInvalid();
      return current;
    }
    catch { return responseInvalid(); }
  }

  async setAgentSettings(
    roomId: string,
    input: AgentSettingsInput,
    options: AnalyticsRequestOptions = {},
  ): Promise<AgentSettingsResponse> {
    let body: AgentSettingsInput;
    try { body = agentContract.parseSettings(input); }
    catch { return responseInvalid(); }
    const response = await this.#request(routes.agent.settings(roomId), {
      method: "PUT",
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status !== 200) {
      return legalError(response, {
        401: ["AUTH_REQUIRED"],
        403: ["FORBIDDEN"],
        404: ["ROOM_NOT_FOUND"],
        409: ["ROOM_DELETION_IN_PROGRESS"],
        500: ["INTERNAL"],
        503: ["AGENT_SERVICE_UNAVAILABLE"],
      });
    }
    try { return agentContract.parseSettingsResponse(await jsonBody(response)); }
    catch { return responseInvalid(); }
  }

  async getDerivedTextArtifacts(
    roomId: string,
    query: DerivedTextArtifactQuery = {},
    options: AnalyticsRequestOptions = {},
  ): Promise<DerivedTextArtifactPage> {
    const effectiveQuery = {
      reviewStatus: query.reviewStatus ?? "unreviewed",
      includeHistory: query.includeHistory ?? false,
      limit: query.limit ?? 50,
      ...(query.afterArtifactId === undefined ? {} : { afterArtifactId: query.afterArtifactId }),
    } as const;
    const response = await this.#request(routes.analytics.artifacts(roomId, effectiveQuery), {
      method: "GET",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status !== 200) {
      return legalError(response, {
        400: ["INVALID_ANALYTICS_QUERY"],
        401: ["AUTH_REQUIRED"],
        404: ["ROOM_NOT_FOUND"],
        410: ["ROOM_DELETION_IN_PROGRESS", "RETENTION_POLICY_EXPIRED"],
        500: ["INTERNAL"],
        503: ["ANALYTICS_CORRUPT"],
      });
    }
    try {
      const page = analyticsContract.parseArtifactPage(await jsonBody(response));
      const last = page.items.at(-1);
      if (page.includeHistory !== effectiveQuery.includeHistory
        || page.items.length > effectiveQuery.limit
        || page.items.some((item) => item.roomId !== roomId
          || item.reviewStatus !== effectiveQuery.reviewStatus
          || (!effectiveQuery.includeHistory && !item.active))
        || page.throughRoomSeq < page.items.reduce((maximum, item) => Math.max(maximum, item.roomSeq), 0)
        || (page.nextAfterArtifactId !== null
          && (!last || page.nextAfterArtifactId !== last.artifactId))) {
        return responseInvalid();
      }
      return page;
    } catch (error) {
      if (error instanceof SessionGatewayError) throw error;
      return responseInvalid();
    }
  }

  async submitAnalyticsReview(
    roomId: string,
    input: AnalyticsReviewCommand,
    options: AnalyticsRequestOptions = {},
  ): Promise<AnalyticsReviewAccepted> {
    let command: AnalyticsReviewCommand;
    try { command = analyticsContract.parseReview(input); }
    catch { return responseInvalid(); }
    const response = await this.#request(routes.analytics.reviews(roomId), {
      method: "POST",
      body: JSON.stringify(command),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status !== 200 && response.status !== 201) {
      return legalError(response, {
        400: ["INVALID_ANALYTICS_REVIEW_COMMAND"],
        401: ["AUTH_REQUIRED"],
        404: ["ROOM_NOT_FOUND", "ANALYTICS_TARGET_NOT_FOUND"],
        409: ["ANALYTICS_VERSION_CONFLICT", "ROOM_NOT_OPEN"],
        410: ["ROOM_DELETION_IN_PROGRESS", "RETENTION_POLICY_EXPIRED"],
        500: ["INTERNAL"],
        503: ["ANALYTICS_CORRUPT"],
      });
    }
    try {
      const accepted = analyticsTeacherHttpContract.parseAccepted(await jsonBody(response));
      const expectedChangeKind = "correctionKind" in command ? "correction" : "review";
      if (accepted.changeKind !== expectedChangeKind) return responseInvalid();
      return accepted;
    } catch (error) {
      if (error instanceof SessionGatewayError) throw error;
      return responseInvalid();
    }
  }

  async getAnalyticsReviewDetail(
    roomId: string,
    reviewEventId: string,
    options: AnalyticsRequestOptions = {},
  ): Promise<AnalyticsReviewDetail> {
    const response = await this.#request(routes.analytics.reviewDetail(roomId, reviewEventId), {
      method: "GET",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status !== 200) {
      return legalError(response, {
        400: ["INVALID_ANALYTICS_QUERY"],
        401: ["AUTH_REQUIRED"],
        404: ["ROOM_NOT_FOUND", "ANALYTICS_REVIEW_NOT_FOUND"],
        410: ["ROOM_DELETION_IN_PROGRESS", "RETENTION_POLICY_EXPIRED"],
        500: ["INTERNAL"],
        503: ["ANALYTICS_CORRUPT"],
      });
    }
    try {
      const detail = analyticsTeacherHttpContract.parseDetail(await jsonBody(response));
      if (detail.roomId !== roomId || detail.reviewEventId !== reviewEventId) return responseInvalid();
      return detail;
    } catch (error) {
      if (error instanceof SessionGatewayError) throw error;
      return responseInvalid();
    }
  }

  async requestRoomDeletion(
    roomId: string,
    options: AnalyticsRequestOptions = {},
  ): Promise<DeleteRoomAccepted> {
    let body: string;
    try { body = deletionLifecycleContract.encodeRequest({ confirmation: `DELETE ${roomId}` }); }
    catch { return responseInvalid(); }
    const response = await this.#request(routes.rooms.delete(roomId), {
      method: "DELETE",
      body,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status !== 202) {
      return legalError(response, {
        400: ["INVALID_DELETE_REQUEST"],
        401: ["AUTH_REQUIRED"],
        404: ["ROOM_NOT_FOUND"],
        409: ["DELETION_IN_PROGRESS"],
        500: ["INTERNAL"],
      });
    }
    try { return deletionLifecycleContract.parseAccepted(await jsonBody(response)); }
    catch (error) {
      if (error instanceof SessionGatewayError) throw error;
      return responseInvalid();
    }
  }

  async getDeletionStatus(
    deletionJobId: string,
    options: AnalyticsRequestOptions = {},
  ): Promise<DeletionStatus> {
    const status = await this.#getDeletionStatus(routes.deletions.get(deletionJobId), options);
    if (status.deletionJobId !== deletionJobId) return responseInvalid();
    return status;
  }

  async getRoomDeletion(
    roomId: string,
    options: AnalyticsRequestOptions = {},
  ): Promise<DeletionStatus> {
    return this.#getDeletionStatus(routes.deletions.forRoom(roomId), options);
  }

  async #getDeletionStatus(path: string, options: AnalyticsRequestOptions): Promise<DeletionStatus> {
    const response = await this.#request(path, {
      method: "GET",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status !== 200) {
      return legalError(response, {
        401: ["AUTH_REQUIRED"],
        404: ["ROOM_NOT_FOUND"],
        500: ["INTERNAL"],
        503: ["DELETION_STATUS_CORRUPT"],
      });
    }
    try { return deletionLifecycleContract.parseStatus(await jsonBody(response)); }
    catch (error) {
      if (error instanceof SessionGatewayError) throw error;
      return responseInvalid();
    }
  }

  async exportRoom(
    roomId: string,
    format: RoomExportFormat,
    options: AnalyticsRequestOptions = {},
  ): Promise<RoomExportFile> {
    const contentType = format === "json" ? "application/json" : "text/csv";
    const response = await this.#request(routes.rooms.export(roomId, format), {
      method: "GET",
      headers: { Accept: contentType },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status !== 200) {
      return legalError(response, {
        400: ["INVALID_EXPORT_FORMAT"],
        401: ["AUTH_REQUIRED"],
        404: ["ROOM_NOT_FOUND"],
        410: ["DELETION_IN_PROGRESS", "RETENTION_POLICY_EXPIRED"],
        500: ["INTERNAL"],
        503: ["EXPORT_UNAVAILABLE"],
      });
    }
    if (!exactUtf8ContentType(response.headers.get("content-type"), contentType)) {
      return responseInvalid();
    }
    const text = await readBoundedExportText(response);
    const validated = format === "json"
      ? validateJsonExport(text, roomId)
      : validateCsvExport(text, roomId);
    return {
      blob: new Blob([validated], { type: contentType }),
      fileName: safeExportFileName(response.headers.get("content-disposition"), format),
      format,
    };
  }

  async getProjectionLatest(
    roomId: string,
    projectionKey: ProjectionKey,
    options: AnalyticsRequestOptions = {},
  ): Promise<ProjectionSnapshot> {
    const response = await this.#request(routes.analytics.latest(roomId, projectionKey), {
      method: "GET",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status !== 200) return legalError(response, ANALYTICS_ERROR_ALLOWLIST);
    try {
      const body = await jsonBody(response);
      const snapshot = projectionKey === "echo.student_approved"
        ? analyticsContract.parseStudentEchoSnapshot(body)
        : projectionKey === "echo.teacher_shadow"
          ? analyticsContract.parseTeacherEchoSnapshot(body)
          : analyticsContract.parseTrace(body);
      if (snapshot.roomId !== roomId || snapshot.projectionKey !== projectionKey) responseInvalid();
      return snapshot;
    } catch (error) {
      if (error instanceof SessionGatewayError) throw error;
      return responseInvalid();
    }
  }

  async getProjectionPatches(
    roomId: string,
    projectionKey: EchoProjectionKey,
    query: Readonly<{ analysisEpoch: string; afterProjectionVersion?: number }>,
    options: AnalyticsRequestOptions = {},
  ): Promise<AnalyticsPatchPage> {
    const response = await this.#request(routes.analytics.patches(roomId, projectionKey, query), {
      method: "GET",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status === 409) {
      let result: AnalyticsResyncResponse;
      try { result = analyticsHttpContract.parseResync(await jsonBody(response)); }
      catch { return responseInvalid(); }
      if (result.snapshotUrl !== routes.analytics.latest(roomId, projectionKey)) responseInvalid();
      throw new SessionGatewayError("SNAPSHOT_RESYNC_REQUIRED");
    }
    if (response.status !== 200) return legalError(response, ANALYTICS_ERROR_ALLOWLIST);
    try {
      const page = projectionKey === "echo.student_approved"
        ? analyticsHttpContract.parseStudentPatchPage(await jsonBody(response))
        : analyticsHttpContract.parseTeacherPatchPage(await jsonBody(response));
      if (page.roomId !== roomId || page.projectionKey !== projectionKey
        || page.analysisEpoch !== query.analysisEpoch) responseInvalid();
      for (const patch of page.patches) {
        if (projectionKey === "echo.student_approved") analyticsContract.parseStudentEchoPatch(patch);
        else analyticsContract.parseTeacherEchoPatch(patch);
        if (patch.analysisEpoch !== query.analysisEpoch) responseInvalid();
      }
      const first = page.patches[0];
      if (first && first.baseVersion !== (query.afterProjectionVersion ?? 0)) responseInvalid();
      return page;
    } catch (error) {
      if (error instanceof SessionGatewayError) throw error;
      return responseInvalid();
    }
  }

  async getConceptTimeline(
    roomId: string,
    projectionKey: EchoProjectionKey,
    query: Readonly<{ analysisEpoch: string; limit?: number }>,
    options: AnalyticsRequestOptions = {},
  ): Promise<AnalyticsTimelineResponse> {
    const response = await this.#request(routes.analytics.timeline(roomId, projectionKey, query), {
      method: "GET",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status === 409) {
      let result: AnalyticsResyncResponse;
      try { result = analyticsHttpContract.parseResync(await jsonBody(response)); }
      catch { return responseInvalid(); }
      if (result.snapshotUrl !== routes.analytics.latest(roomId, projectionKey)) responseInvalid();
      throw new SessionGatewayError("SNAPSHOT_RESYNC_REQUIRED");
    }
    if (response.status !== 200) return legalError(response, ANALYTICS_ERROR_ALLOWLIST);
    try {
      const timeline = projectionKey === "echo.student_approved"
        ? analyticsHttpContract.parseStudentTimeline(await jsonBody(response))
        : analyticsHttpContract.parseTeacherTimeline(await jsonBody(response));
      if (timeline.roomId !== roomId || timeline.projectionKey !== projectionKey
        || timeline.analysisEpoch !== query.analysisEpoch) responseInvalid();
      if (timeline.baseSnapshot
        && (timeline.baseSnapshot.roomId !== roomId
          || timeline.baseSnapshot.projectionKey !== projectionKey
          || timeline.baseSnapshot.analysisEpoch !== query.analysisEpoch)) responseInvalid();
      for (const patch of timeline.patches) {
        if (projectionKey === "echo.student_approved") analyticsContract.parseStudentEchoPatch(patch);
        else analyticsContract.parseTeacherEchoPatch(patch);
        if (patch.analysisEpoch !== query.analysisEpoch) responseInvalid();
      }
      return timeline;
    } catch (error) {
      if (error instanceof SessionGatewayError) throw error;
      return responseInvalid();
    }
  }

  async logout(): Promise<void> {
    const response = await this.#request(routes.auth.session(), { method: "DELETE" });
    if (response.status !== 204) responseInvalid();
    let body: string;
    try { body = await response.text(); }
    catch { return responseInvalid(); }
    if (body !== "") responseInvalid();
  }
}
