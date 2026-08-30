import {
  apiErrorContract,
  agentContract,
  authContract,
  mediaAttachmentContract,
  mediaCommandContract,
  roomHttpContract,
  routes,
  teacherRoomListContract,
  type ApiError,
  type AgentCurrentState,
  type AuthSession,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type CompleteMediaUploadResponse,
  type CreateMediaUploadInput,
  type JoinRoomRequest,
  type MediaAttachmentView,
  type MediaDownloadGrant,
  type MediaUploadGrant,
  type RoomDetails,
  type RoomEventPage,
  type TeacherMagicLinkAccepted,
  type TeacherMagicLinkRequest,
  type TeacherRoomListResponse,
} from "@learning-orbit/contracts";

type FetchLike = typeof globalThis.fetch;

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
  logout(): Promise<void>;
}

export class SessionGatewayError extends Error {
  constructor(readonly code: ApiError["code"] | "SESSION_NETWORK_FAILURE" | "SESSION_RESPONSE_INVALID" | "SESSION_IDENTITY_MISMATCH") {
    super(code);
    this.name = "SessionGatewayError";
  }
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
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") throw new SessionGatewayError("SESSION_NETWORK_FAILURE");
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

  async logout(): Promise<void> {
    const response = await this.#request(routes.auth.session(), { method: "DELETE" });
    if (response.status !== 204 || response.body !== null) responseInvalid();
  }
}
