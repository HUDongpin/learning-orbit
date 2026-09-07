import type { Pool, PoolClient } from "pg";

import type { Clock } from "../../clock.js";
import type { RoomHub } from "../realtime/room-hub.js";
import {
  parsePolicyChangeNotice,
  POLICY_CHANGE_CHANNEL,
  STUDENT_PROJECTION_KEYS,
  type StudentAnalyticsPromotionService,
  type StudentProjectionKey,
} from "./student-analytics-promotion.js";

export interface PolicyListenerPorts {
  /** Sockets currently attached to a room, so a change reaches live students. */
  readonly hub: Pick<RoomHub, "broadcastDegraded" | "connectedRoomIds">;
  readonly promotions: Pick<StudentAnalyticsPromotionService, "currentAllowlist">;
  readonly clock: Clock;
}

/**
 * Apply a visibility change to the sockets already open.
 *
 * Revocation that only takes effect on the next request is not revocation: a
 * student sitting on an open panel would keep receiving projection pointers
 * until they happened to reload. The listener therefore tells affected sockets
 * immediately, and re-reads the durable row rather than trusting the
 * notification's own contents.
 *
 * A lost notification degrades to a delay, not to stale access: every room is
 * reconciled on start, and the read path re-checks the durable policy on every
 * request and every projection send regardless.
 */
export class StudentAnalyticsPolicyListener {
  #client: PoolClient | undefined;
  #stopped = false;
  readonly #lastRevision = new Map<string, number>();

  constructor(
    private readonly pool: Pool,
    private readonly ports: PolicyListenerPorts,
  ) {}

  async start(): Promise<void> {
    if (this.#client || this.#stopped) return;
    const client = await this.pool.connect();
    this.#client = client;
    client.on("notification", (message) => {
      if (message.channel !== POLICY_CHANGE_CHANNEL || typeof message.payload !== "string") return;
      void this.#apply(message.payload).catch(() => undefined);
    });
    // A dropped connection must not silently stop enforcement.
    client.on("error", () => { void this.#reconnect(); });
    await client.query(`LISTEN ${POLICY_CHANGE_CHANNEL}`);
    await this.reconcileConnectedRooms();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    const client = this.#client;
    this.#client = undefined;
    if (!client) return;
    try { await client.query(`UNLISTEN ${POLICY_CHANGE_CHANNEL}`); } catch { /* closing anyway */ }
    client.release();
  }

  /** Re-read every connected room; used at start and after a reconnect. */
  async reconcileConnectedRooms(): Promise<void> {
    for (const roomId of this.ports.hub.connectedRoomIds()) {
      const allowed = await this.ports.promotions.currentAllowlist(roomId);
      const withheld = STUDENT_PROJECTION_KEYS.filter((key) => !allowed.has(key));
      await this.#announceWithheld(roomId, withheld);
    }
  }

  async #reconnect(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    if (client) { try { client.release(true); } catch { /* already gone */ } }
    if (this.#stopped) return;
    await this.start().catch(() => undefined);
  }

  async #apply(payload: string): Promise<void> {
    const notice = parsePolicyChangeNotice(payload);
    // Revisions are monotonic per room, so a reordered or replayed
    // notification is dropped rather than allowed to re-open access.
    const seen = this.#lastRevision.get(notice.roomId);
    if (seen !== undefined && notice.revision <= seen) return;
    this.#lastRevision.set(notice.roomId, notice.revision);

    const allowed = await this.ports.promotions.currentAllowlist(notice.roomId);
    const withheld = notice.changedKeys.filter((key) => !allowed.has(key));
    await this.#announceWithheld(notice.roomId, withheld);
  }

  async #announceWithheld(
    roomId: string,
    withheld: readonly StudentProjectionKey[],
  ): Promise<void> {
    for (const projectionKey of withheld) {
      await this.ports.hub.broadcastDegraded(roomId, {
        type: "degraded",
        scope: "analytics",
        code: "STUDENT_ANALYTICS_NOT_PROMOTED",
        projectionKey,
        updatedAt: this.ports.clock.now().toISOString(),
      });
    }
  }
}
