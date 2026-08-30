import {
  apiErrorContract,
  authContract,
  roomHttpContract,
  routes,
  teacherRoomListContract,
  type ApiError,
  type AuthSession,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type JoinRoomRequest,
  type RoomDetails,
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

  async logout(): Promise<void> {
    const response = await this.#request(routes.auth.session(), { method: "DELETE" });
    if (response.status !== 204 || response.body !== null) responseInvalid();
  }
}
