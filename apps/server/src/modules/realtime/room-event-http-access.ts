import type { TokenAuthorization } from "./realtime-delivery-authorizer.js";

export type RoomEventHttpAccessFailure = Readonly<{
  statusCode: 404;
  code: "ROOM_NOT_FOUND";
}>;

/**
 * The route has already established a valid browser Session before calling
 * this mapper. Any later room-token failure, including a get/reauthorize race,
 * is therefore an opaque room miss rather than evidence that the Session is
 * expired. This prevents foreign-room requests and 4410 from becoming login
 * oracles/redirect loops.
 */
export function roomEventHttpAccessFailure(
  authorization: TokenAuthorization,
): RoomEventHttpAccessFailure | null {
  if (authorization.ok) return null;
  return { statusCode: 404, code: "ROOM_NOT_FOUND" };
}
