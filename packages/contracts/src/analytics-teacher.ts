import type { ValidateFunction } from "ajv";

import teacherSchema from "../schemas/analytics-teacher-http.v1.json" with { type: "json" };
import reviewSchema from "../schemas/analytics-review-command.v1.json" with { type: "json" };
import type {
  AnalyticsReviewAccepted,
  AnalyticsReviewDetail,
} from "./generated/analytics-teacher-http.v1.js";
import { makeSchemaAjv } from "./schema-ajv.js";
import { analyticsContract } from "./analytics.js";

const ajv = makeSchemaAjv();
ajv.addSchema(reviewSchema);
ajv.addSchema(teacherSchema);

function validator<T>(id: string): ValidateFunction<T> {
  const value = ajv.getSchema(id);
  if (!value) throw new Error("ANALYTICS_TEACHER_SCHEMA_REGISTRATION_FAILED");
  return value as ValidateFunction<T>;
}

const accepted = validator<AnalyticsReviewAccepted>(`${teacherSchema.$id}#/$defs/AnalyticsReviewAccepted`);
const detail = validator<AnalyticsReviewDetail>(`${teacherSchema.$id}#/$defs/AnalyticsReviewDetail`);

function parse<T>(value: unknown, check: ValidateFunction<T>, code: string): T {
  if (!check(value)) throw new Error(code);
  return value;
}

export const analyticsTeacherHttpContract = {
  parseAccepted(value: unknown): AnalyticsReviewAccepted {
    return parse(value, accepted, "INVALID_ANALYTICS_REVIEW_ACCEPTED");
  },
  parseDetail(value: unknown): AnalyticsReviewDetail {
    const result = parse(value, detail, "INVALID_ANALYTICS_REVIEW_DETAIL");
    const command = analyticsContract.parseReview(result.payload);
    const correction = "correctionKind" in command;
    if ((result.changeKind === "correction") !== correction) {
      throw new Error("INVALID_ANALYTICS_REVIEW_DETAIL");
    }
    return result;
  },
  encodeAccepted(value: unknown): string { return JSON.stringify(this.parseAccepted(value)); },
  encodeDetail(value: unknown): string { return JSON.stringify(this.parseDetail(value)); },
};

export type { AnalyticsReviewAccepted, AnalyticsReviewDetail } from "./generated/analytics-teacher-http.v1.js";
