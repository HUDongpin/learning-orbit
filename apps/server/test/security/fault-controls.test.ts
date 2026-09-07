import { describe, expect, it } from "vitest";

import {
  FAULT_NAMES,
  FaultControlError,
  FaultController,
  faultControlsEnabled,
} from "../../src/modules/security/fault-controls.js";
import { forbidsAnyOrigin, isFaultControlPath } from "../../src/modules/security/origin-policy.js";
import type { FastifyRequest } from "fastify";

function request(url: string, method = "POST"): FastifyRequest {
  return { method, headers: {}, routeOptions: { url } } as unknown as FastifyRequest;
}

describe("fault control admission", () => {
  it("is off unless the variable is set", () => {
    expect(faultControlsEnabled({})).toBe(false);
    expect(faultControlsEnabled({ NODE_ENV: "production" })).toBe(false);
  });

  it("refuses to run in production rather than ignoring the variable", () => {
    // Silently dropping it would leave an operator believing faults were
    // disarmed because nothing complained.
    expect(() => faultControlsEnabled({ LEARNING_ORBIT_TEST_FAULTS: "1", NODE_ENV: "production" }))
      .toThrow("TEST_FAULTS_FORBIDDEN_IN_PRODUCTION");
    expect(() => faultControlsEnabled({ LEARNING_ORBIT_TEST_FAULTS: "0", NODE_ENV: "production" }))
      .toThrow("TEST_FAULTS_FORBIDDEN_IN_PRODUCTION");
  });

  it("refuses a value that is not exactly 1, outside production too", () => {
    for (const value of ["0", "true", "yes", ""]) {
      expect(() => faultControlsEnabled({ LEARNING_ORBIT_TEST_FAULTS: value, NODE_ENV: "test" }))
        .toThrow("TEST_FAULTS_INVALID");
    }
    expect(faultControlsEnabled({ LEARNING_ORBIT_TEST_FAULTS: "1", NODE_ENV: "test" })).toBe(true);
  });

  it("keeps every browser out of the fault surface", () => {
    expect(isFaultControlPath("/test/faults/outbox.paused")).toBe(true);
    expect(isFaultControlPath("/v1/rooms")).toBe(false);
    // A page on the product origin that could pause the outbox would be a
    // denial of service dressed as a link.
    expect(forbidsAnyOrigin(request("/test/faults/outbox.paused"))).toBe(true);
    expect(forbidsAnyOrigin(request("/v1/rooms"))).toBe(false);
  });
});

describe("fault controller", () => {
  it("arms and clears each named fault", () => {
    const faults = new FaultController();
    expect(faults.outboxPaused).toBe(false);
    faults.arm("outbox.paused", true);
    expect(faults.outboxPaused).toBe(true);
    faults.arm("outbox.paused", false);
    expect(faults.outboxPaused).toBe(false);
  });

  it("drops one acknowledgement, not every later one", () => {
    const faults = new FaultController();
    faults.arm("websocket.drop_next_ack", true);
    expect(faults.takeAckDrop()).toBe(true);
    // A scenario that armed it then took an unexpected path would otherwise
    // silently break every send after it.
    expect(faults.takeAckDrop()).toBe(false);
  });

  it("refuses a fault it does not have a name for", () => {
    const faults = new FaultController();
    expect(() => faults.arm("database.drop_tables", true)).toThrow(FaultControlError);
    expect(() => faults.arm("database.drop_tables", true)).toThrow("FAULT_UNKNOWN");
  });

  it("refuses a value of the wrong shape", () => {
    const faults = new FaultController();
    expect(() => faults.arm("outbox.paused", "yes")).toThrow("FAULT_VALUE_INVALID");
    expect(() => faults.arm("client.clock_skew_ms", 1.5)).toThrow("FAULT_VALUE_INVALID");
  });

  it("bounds a clock skew to one day either way", () => {
    const faults = new FaultController();
    const day = 24 * 60 * 60 * 1000;
    faults.arm("client.clock_skew_ms", -day);
    expect(faults.clockSkewMs).toBe(-day);
    // An unbounded skew would prove an expiry can be stepped past, not that it
    // works.
    expect(() => faults.arm("client.clock_skew_ms", day + 1)).toThrow("FAULT_VALUE_INVALID");
  });

  it("returns to normal on reset, so one scenario cannot poison the next", () => {
    const faults = new FaultController();
    for (const name of FAULT_NAMES) {
      faults.arm(name, name === "client.clock_skew_ms" ? 5_000 : true);
    }
    faults.reset();
    expect(faults.snapshot()).toEqual({
      "outbox.paused": false,
      "websocket.drop_next_ack": false,
      "worker.crash_after_claim": false,
      "client.clock_skew_ms": 0,
    });
  });
});
