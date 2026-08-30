import type { Pool } from "pg";
import { AnalyticsPolicy } from "./analytics-policy.js";

/** Composition boundary for the later retention/deletion/promotion policy. */
export class AnalyticsRoomAccessPort extends AnalyticsPolicy {
  constructor(pool: Pool) { super(pool); }
}
