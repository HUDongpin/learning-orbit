import type { PoolClient } from "pg";
import type { AuthSession } from "@learning-orbit/contracts";
import { RoomError } from "./errors.js";
export interface AttachmentValidator { assertAttachable(tx: PoolClient, principal: AuthSession, roomId: string, mediaIds: readonly string[]): Promise<void>; }
export const noAttachments: AttachmentValidator = { async assertAttachable(_tx, _p, _r, ids) { if (ids.length) throw new RoomError("INVALID_COMMAND"); } };
