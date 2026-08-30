import { analyticsReviewRoomEventPayloadSchema } from "@learning-orbit/contracts";
import type { EventPayloadRegistry } from "@learning-orbit/contracts";

/** Register the only content-free analytics notices allowed on RoomEvent. */
export function registerAnalyticsReviewEventPayloads(registry: EventPayloadRegistry): void {
  const schema = analyticsReviewRoomEventPayloadSchema;
  const defs = schema.$defs as Record<string, Record<string, unknown>>;
  const closed = (name: string) => ({
    $schema: schema.$schema,
    $id: `https://learning-orbit.local/schemas/${name}.v1.json`,
    ...defs[name],
  });
  registry.register("analytics.review.recorded.v1", closed("AnalyticsReviewNoticePayload"));
  registry.register("analytics.correction.recorded.v1", closed("AnalyticsCorrectionNoticePayload"));
}
