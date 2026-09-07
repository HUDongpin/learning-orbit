import assert from "node:assert/strict";
import { it as test } from "vitest";

import {
  containerEnvironment,
  containerOrigin,
  dockerArgv,
  loadOrigin,
  lockedImage,
} from "../../scripts/run-k6-pilot.mjs";

const DIGEST = "sha256:9bd01d6941fca969cb61bb57d2da5ee9b385fe2aa8881df3798c196564d6ace6";
const lock = { images: { k6: { reference: "grafana/k6:2.2.0", digest: DIGEST } } };

test("runs the image the lock pinned, by digest", () => {
  assert.equal(lockedImage(lock), `grafana/k6:2.2.0@${DIGEST}`);
});

test("refuses a mutable tag before Docker starts", () => {
  // A tag names whatever was pushed last, which is not the thing anyone
  // reviewed. An entry without a digest is refused rather than resolved.
  assert.throws(() => lockedImage({ images: { k6: { reference: "grafana/k6:2.2.0" } } }), /K6_IMAGE_NOT_PINNED/);
  assert.throws(() => lockedImage({ images: { k6: { reference: "grafana/k6:latest", digest: "latest" } } }), /K6_IMAGE_NOT_PINNED/);
  assert.throws(() => lockedImage({ images: {} }), /K6_IMAGE_NOT_PINNED/);
});

test("accepts https anywhere and http only on loopback", () => {
  assert.equal(loadOrigin("https://pilot.example"), "https://pilot.example");
  assert.equal(loadOrigin("http://localhost:3000"), "http://localhost:3000");
  assert.equal(loadOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
});

test("refuses an origin carrying credentials, a path, or plaintext off-host", () => {
  for (const value of [
    "http://pilot.example",
    "https://user:pass@pilot.example",
    "https://pilot.example/v1",
    "pilot.example",
    undefined,
  ]) {
    assert.throws(() => loadOrigin(value as string), /K6_ORIGIN_INVALID/, `accepted ${String(value)}`);
  }
});

test("forwards only the allowlisted variable, never the host environment", () => {
  const argv = containerEnvironment("https://pilot.example");
  assert.deepEqual(argv, ["--env", "LO_LOAD_ORIGIN=https://pilot.example"]);
  // A variable added to the allowlist without a value fails rather than
  // silently sending nothing.
  assert.throws(() => containerEnvironment("https://pilot.example", ["DATABASE_URL"]), /K6_ENV_UNSET:DATABASE_URL/);
});

test("rewrites a loopback origin to an address the container can reach", () => {
  assert.equal(containerOrigin("http://localhost:3200"), "http://host.docker.internal:3200");
  assert.equal(containerOrigin("http://127.0.0.1:3200"), "http://host.docker.internal:3200");
  // A real host is left exactly as the operator named it.
  assert.equal(containerOrigin("https://pilot.example"), "https://pilot.example");
});

test("mounts the profile read-only and nothing but the output writable", () => {
  const argv = dockerArgv({
    image: "image@sha256:0", origin: "https://pilot.example",
    profileDir: "/repo/tests/load", outputDir: "/repo/test-results/load", network: "host",
  });
  assert.ok(argv.includes("--rm"));
  assert.ok(argv.includes("/repo/tests/load:/profile:ro"));
  assert.ok(argv.includes("/repo/test-results/load:/out"));
  const mounts = argv.filter((_value, index) => argv[index - 1] === "--volume");
  assert.equal(mounts.length, 2);
  // No shell, no repository mount, and the profile path is fixed rather than
  // taken from an argument.
  assert.ok(argv.includes("/profile/k6-read-surface.js"));
  assert.ok(!argv.some((value) => value.includes("sh -c") || value === "/repo"));
});
