import { describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { apiErrorContract } from "@learning-orbit/contracts";
import {
  forbidsAnyOrigin,
  isInternalRoutePath,
  requiresAllowedOrigin,
} from "../../src/modules/security/origin-policy.js";
import { normalizeRateIp } from "../../src/modules/security/rate-policies.js";
import { buildRatePolicyHarness } from "../fixtures/rate-policy-harness.js";
import { routes } from "@learning-orbit/contracts";

const allowedOrigin = "https://app.learning-orbit.test";

describe("origin and rate policy", () => {
  it("requires exact origins for unsafe requests while allowing originless same-origin reads", async () => {
    const app = await buildApp({ config: { allowedOrigins: [allowedOrigin], publicBaseOrigin: allowedOrigin } });
    expect((await app.inject({ method: "POST", url: "/v1/auth/teacher/magic-link", payload: { email: "x@example.edu" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/auth/teacher/magic-link", payload: { email: "x@example.edu" }, headers: { origin: "https://wrong.example" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/auth/session" })).statusCode).not.toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/auth/session", headers: { origin: "https://wrong.example" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/auth/teacher/magic-link/consume?token=x" })).statusCode).toBe(400);
    expect((await app.inject({ method: "HEAD", url: "/v1/auth/teacher/magic-link/consume?token=x" })).statusCode).toBe(403);
    expect((await app.inject({
      method: "HEAD",
      url: "/v1/auth/teacher/magic-link/consume?token=x",
      headers: { origin: allowedOrigin },
    })).statusCode).toBe(405);
    expect((await app.inject({ method: "GET", url: "/v1/auth/teacher/magic-link/consume-extra?token=x" })).statusCode).toBe(404);
    await app.close();
  });

  it("still requires an Origin for WebSocket upgrades", () => {
    expect(requiresAllowedOrigin({
      method: "GET",
      headers: { upgrade: "websocket" },
      routeOptions: { url: "/v1/rooms/:roomId/realtime" },
    } as never)).toBe(true);
    expect(requiresAllowedOrigin({
      method: "GET",
      headers: {},
      routeOptions: { url: "/v1/auth/session" },
    } as never)).toBe(false);
    expect(requiresAllowedOrigin({
      method: "HEAD",
      headers: {},
      routeOptions: { url: "/v1/auth/teacher/magic-link/consume" },
    } as never)).toBe(true);
  });

  it("exempts every canonical internal route from the browser-origin rule", () => {
    // Derived from the route table, not restated: a hand-kept list already
    // locked the provider-health probe out of its own route.
    const internal = [
      routes.internal.rooms.autoClose(),
      routes.internal.media.reconcileUpload(),
      routes.internal.media.outcome(),
      routes.internal.agent.health(),
      routes.internal.agent.complete(),
      routes.internal.lifecycle.mediaSurface(),
    ];
    expect(new Set(internal).size).toBe(6);
    for (const url of internal) {
      expect(isInternalRoutePath(url)).toBe(true);
      expect(requiresAllowedOrigin({ method: "POST", headers: {}, routeOptions: { url } } as never))
        .toBe(false);
      expect(forbidsAnyOrigin({ routeOptions: { url } } as never)).toBe(true);
    }
    expect(isInternalRoutePath("/internal/rooms/auto-close-extra")).toBe(false);
    expect(forbidsAnyOrigin({ routeOptions: { url: "/v1/auth/session" } } as never)).toBe(false);
  });

  it("uses production policy definitions for magic, failed join, and agent triggers", async () => {
    const app = await buildRatePolicyHarness();
    const magic = await Promise.all(Array.from({ length: 6 }, () => app.inject({ method: "POST", url: "/magic" })));
    expect(magic[5]?.statusCode).toBe(429);
    expect(magic[5]?.body).toBe('{"code":"RATE_LIMITED"}');
    expect(apiErrorContract.parse(magic[5]?.json())).toEqual({ code: "RATE_LIMITED" });
    for (let i = 0; i < 10; i += 1) expect((await app.inject({ method: "POST", url: "/failed-join" })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/failed-join" })).statusCode).toBe(429);
    for (let i = 0; i < 3; i += 1) expect((await app.inject({ method: "POST", url: "/agent?roomId=r&actorId=a" })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/agent?roomId=r&actorId=a" })).statusCode).toBe(429);
    await app.close();
  });

  it("does not trust forwarded IPs unless an explicit proxy CIDR does, normalizes mapped addresses, and separates actors", async () => {
    const untrusted = await buildRatePolicyHarness(false);
    for (let i = 0; i < 5; i += 1) expect((await untrusted.inject({ method: "POST", url: "/magic", headers: { "x-forwarded-for": `198.51.100.${i + 1}` } })).statusCode).toBe(204);
    expect((await untrusted.inject({ method: "POST", url: "/magic", headers: { "x-forwarded-for": "203.0.113.99" } })).statusCode).toBe(429);
    await untrusted.close();

    const trusted = await buildRatePolicyHarness(["127.0.0.1/8"]);
    for (let i = 0; i < 5; i += 1) expect((await trusted.inject({ method: "POST", url: "/magic", headers: { "x-forwarded-for": `::ffff:192.0.2.${i + 1}` } })).statusCode).toBe(204);
    expect((await trusted.inject({ method: "POST", url: "/magic", headers: { "x-forwarded-for": "::ffff:192.0.2.1" } })).statusCode).toBe(204);
    expect(normalizeRateIp("::ffff:192.0.2.1")).toBe(normalizeRateIp("192.0.2.1"));
    expect(normalizeRateIp("2001:db8:abcd:1::1")).toBe(normalizeRateIp("2001:db8:abcd:1::2"));
    const ipv6Rotation = await buildRatePolicyHarness(["127.0.0.1/8"]);
    for (let i = 1; i <= 5; i += 1) {
      expect((await ipv6Rotation.inject({
        method: "POST",
        url: "/magic",
        headers: { "x-forwarded-for": `2001:db8:beef:42::${i}` },
      })).statusCode).toBe(204);
    }
    expect((await ipv6Rotation.inject({
      method: "POST",
      url: "/magic",
      headers: { "x-forwarded-for": "2001:db8:beef:42::6" },
    })).statusCode).toBe(429);
    await ipv6Rotation.close();
    for (const actorId of ["a", "b", "c", "d"]) {
      for (let i = 0; i < 3; i += 1) expect((await trusted.inject({ method: "POST", url: `/agent?roomId=r&actorId=${actorId}`, headers: { "x-forwarded-for": "2001:db8:abcd:1::1" } })).statusCode).toBe(204);
    }
    expect((await trusted.inject({ method: "POST", url: "/agent?roomId=r&actorId=a", headers: { "x-forwarded-for": "2001:db8:abcd:1::2" } })).statusCode).toBe(429);
    await trusted.close();
  });

  it("keeps test-only probes out of the production app", async () => {
    const app = await buildApp({ config: { allowedOrigins: [allowedOrigin], publicBaseOrigin: allowedOrigin } });
    expect((await app.inject({ method: "POST", url: "/__test/rate/agent", headers: { origin: allowedOrigin } })).statusCode).toBe(404);
    await app.close();
  });

  it("rejects a cross-origin request before it can consume a legitimate magic-link rate bucket", async () => {
    const app = await buildApp({ config: { allowedOrigins: [allowedOrigin], publicBaseOrigin: allowedOrigin } });
    for (let i = 0; i < 5; i += 1) {
      expect((await app.inject({ method: "POST", url: "/v1/auth/teacher/magic-link", payload: { email: "x@example.edu" }, headers: { origin: "https://wrong.example" } })).statusCode).toBe(403);
    }
    for (let i = 0; i < 5; i += 1) {
      expect((await app.inject({ method: "POST", url: "/v1/auth/teacher/magic-link", payload: { email: "x@example.edu" }, headers: { origin: allowedOrigin } })).statusCode).toBe(202);
    }
    expect((await app.inject({ method: "POST", url: "/v1/auth/teacher/magic-link", payload: { email: "x@example.edu" }, headers: { origin: allowedOrigin } })).statusCode).toBe(429);
    await app.close();
  });
});
