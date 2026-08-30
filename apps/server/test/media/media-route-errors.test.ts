import { describe, expect, it } from "vitest";

import { MediaError } from "../../src/modules/media/media-errors.js";
import { mediaRouteError } from "../../src/modules/media/media-routes.js";

describe("media HTTP error boundary", () => {
  it("maps every unconfigured or rejected storage surface to one content-free unavailable response", () => {
    for (const error of [
      new Error("STORAGE_NOT_CONFIGURED"),
      new MediaError("STORAGE_NOT_CONFIGURED", 500),
      new MediaError("STORAGE_ORIGIN_NOT_ALLOWED", 502),
      new MediaError("STORAGE_CHECKSUM_BINDING_MISMATCH", 502),
    ]) {
      expect(mediaRouteError(error)).toEqual({ status: 503, body: { code: "MEDIA_SERVICE_UNAVAILABLE" } });
    }
  });

  it("preserves only bounded public media errors and hides every internal detail", () => {
    expect(mediaRouteError(new MediaError("MEDIA_NOT_FOUND", 404))).toEqual({ status: 404, body: { code: "MEDIA_NOT_FOUND" } });
    expect(mediaRouteError(new MediaError("MEDIA_UPLOAD_NOT_SETTLED", 409))).toEqual({ status: 409, body: { code: "MEDIA_UPLOAD_NOT_SETTLED" } });
    expect(mediaRouteError(new MediaError("database host secret", 500))).toEqual({ status: 500, body: { code: "INTERNAL" } });
    expect(mediaRouteError(new MediaError("INVALID_MEDIA_STATE", 500))).toEqual({ status: 500, body: { code: "INTERNAL" } });
    expect(mediaRouteError(new Error("database host secret"))).toEqual({ status: 500, body: { code: "INTERNAL" } });
  });
});
