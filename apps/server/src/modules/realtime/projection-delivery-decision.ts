import { AnalyticsPolicyError } from "../analytics/analytics-policy.js";
import type { ProjectionDeliveryDecision } from "./room-hub.js";

/**
 * Projection policy denial is not equivalent to losing room authority.
 * Only failures that invalidate the underlying session/room may close the
 * shared classroom socket; role- or projection-scoped denial is a silent skip.
 */
export function projectionDeliveryFailureDecision(error: unknown): ProjectionDeliveryDecision {
  if (!(error instanceof AnalyticsPolicyError)) return { allow: false };
  if (error.statusCode === 401 && error.code === "AUTH_REQUIRED") {
    return { allow: false, closeCode: 4401 };
  }
  if (error.statusCode === 404 && error.code === "ROOM_NOT_FOUND") {
    return { allow: false, closeCode: 4403 };
  }
  if (error.statusCode === 410 && error.code === "ROOM_DELETION_IN_PROGRESS") {
    return { allow: false, closeCode: 4410 };
  }
  return { allow: false };
}
