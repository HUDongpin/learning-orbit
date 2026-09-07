import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { routes } from "@learning-orbit/contracts";

/**
 * The ingress is configuration, not code, so nothing else would notice if a
 * later edit dropped one of its rules. These assertions read the file as text
 * — the same approach the accessibility contract takes to globals.css — and
 * pin the properties that are load-bearing for the security model.
 */
const config = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../infra/docker/ingress.conf"),
  "utf8",
);

/** Every internal path the canonical route table knows about. */
function internalPaths(node: unknown, found: string[] = []): string[] {
  if (typeof node === "function") {
    const value = (node as () => unknown)();
    if (typeof value === "string" && value.startsWith("/internal/")) found.push(value);
    return found;
  }
  if (node && typeof node === "object") for (const child of Object.values(node)) internalPaths(child, found);
  return found;
}

describe("production ingress surface", () => {
  it("serves the API and the app from one origin", () => {
    expect(config).toMatch(/location \^~ \/v1\/ \{[\s\S]*?proxy_pass http:\/\/learning_orbit_api;/);
    expect(config).toMatch(/location \/ \{[\s\S]*?proxy_pass http:\/\/learning_orbit_web;/);
  });

  it("returns 404 for every internal route rather than proxying it", () => {
    const paths = internalPaths(routes.internal);
    expect(paths.length).toBeGreaterThan(0);
    expect(config).toContain("location ^~ /internal/ { return 404; }");
    // A prefix rule covers the paths, but only if they all share the prefix
    // the rule names — which a new route table could quietly stop doing.
    for (const path of paths) expect(path.startsWith("/internal/")).toBe(true);
    // Every non-comment mention of /internal must be a refusal. Matching the
    // whole line, rather than searching for a nearby proxy_pass, is what makes
    // a future `location /internal/ { proxy_pass ... }` fail here.
    const mentions = config.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("/internal") && !line.startsWith("#"));
    expect(mentions.length).toBeGreaterThan(0);
    for (const line of mentions) expect(line).toMatch(/^location [^{]*\{ return 404; \}$/);
  });

  it("refuses the fault-control surface as well", () => {
    // The server refuses to start in production with faults enabled; the
    // ingress refuses the path regardless. Two independent answers to "can the
    // public pause the outbox" is the right number.
    expect(config).toContain("location ^~ /test/ { return 404; }");
  });

  it("strips a client-supplied service assertion instead of forwarding it", () => {
    expect(config).toContain('proxy_set_header X-LO-Service-Assertion "";');
  });

  it("keeps a WebSocket open for longer than a full session", () => {
    const readTimeout = /proxy_read_timeout (\d+)s;/.exec(config)?.[1];
    expect(Number(readTimeout)).toBeGreaterThan(45 * 60);
    expect(config).toContain("proxy_set_header Upgrade $http_upgrade;");
  });

  it("redirects plaintext and asks browsers not to try it again", () => {
    expect(config).toMatch(/listen 80;[\s\S]*?return 308 https:/);
    expect(config).toMatch(/Strict-Transport-Security "max-age=31536000/);
  });
});
