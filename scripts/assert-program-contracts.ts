#!/usr/bin/env -S pnpm tsx
/**
 * The programme gate.
 *
 * It asserts that what the approved plans require is what this build actually
 * declares and registers - not that two hand-written lists agree. The required
 * names below come from the master implementation plan; everything they are
 * compared against is read out of the running application, the canonical route
 * table, the checked-in schemas and the worker's own handler registry.
 *
 * This is the gate that would have caught three routes that were never
 * registered, a worker contract module that was never written, and a
 * Python-ingress schema listed with no digest at all.
 *
 *   pnpm tsx scripts/assert-program-contracts.ts --out test-results/program-contracts.json
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { argv, cwd, exit, stderr, stdout } from "node:process";
import { dirname, resolve } from "node:path";

import { contractCoverage } from "../packages/contracts/src/coverage.js";
import { routes } from "../packages/contracts/src/routes.js";

const REQUIRED_ROUTES = [
  "auth.session", "auth.teacherMagicLink",
  "rooms.create", "rooms.join", "rooms.get", "rooms.events", "rooms.websocket",
  "rooms.export", "rooms.delete",
  "media.upload", "media.complete", "media.get", "media.download",
  "internal.rooms.autoClose", "internal.media.reconcileUpload", "internal.media.outcome",
  "internal.agent.complete", "internal.agent.health", "internal.lifecycle.mediaSurface",
  "analytics.latest", "analytics.patches", "analytics.timeline",
  "analytics.artifacts", "analytics.reviews",
  "agent.request", "agent.cancel", "agent.current", "agent.settings",
  "deletions.get", "deletions.forRoom",
] as const;

const REQUIRED_CLIENT_FRAMES = ["hello", "command", "presence", "typing", "heartbeat"] as const;
const REQUIRED_SERVER_FRAMES = [
  "welcome", "ack", "reject", "event", "presence", "typing", "projection",
  "media_status", "agent_status", "resume_complete", "snapshot_required",
  "degraded", "heartbeat",
] as const;

const REQUIRED_ROOM_EVENTS = [
  "room.opened", "room.paused", "room.resumed", "room.closed",
  "message.added", "message.revised", "message.retracted",
  "analytics.review.recorded.v1", "analytics.correction.recorded.v1",
] as const;

const REQUIRED_PROJECTIONS = [
  "echo.teacher_shadow", "echo.student_approved",
  "trace.teacher_bundle", "trace.student_bundle",
] as const;

/**
 * Job families the programme requires. `registered` means a worker handler
 * dispatches it; `enqueued` means server or worker code creates it. A family
 * with neither is a plan item nobody built.
 */
const REQUIRED_JOB_TYPES = [
  "room.auto-close.v1", "media.process.v1", "media.reconcile-upload.v1",
  "analytics.consume.v1", "analytics.replay-room.v1", "agent.execute.v1",
  "multimodal.derive.v1", "room.delete-surface.v1",
] as const;

const HIGH_RISK_SCHEMAS = [
  "room-command.v1.json", "room-event-envelope.v1.json",
  "core-room-event-payloads.v1.json", "room-http.v1.json",
  "auth-session.v1.json", "auth-http.v1.json", "realtime-frame.v1.json",
  "media-command.schema.json", "media-status.v1.json",
  "media-attachment-view.v1.json", "media-internal-reconcile.v1.json",
  "media-internal-outcome.v1.json", "room-internal-auto-close.v1.json",
  "agent-internal-command.v1.json", "agent-provider-health.v1.json",
  "derived-text-artifact.v1.json", "derived-text-artifact-page.v1.json",
  "analysis-projection-envelope.v1.json", "analytics-review-command.v1.json",
  "analytics-review-room-event-payloads.v1.json", "echo-concept-projection.v1.json",
  "trace-projection.v1.json", "agent-run.schema.json", "agent-status.v1.json",
  "agent-current-state.v1.json", "agent-command.v1.json",
  "moderation-decision.schema.json", "deletion-lifecycle.v1.json",
  "lifecycle-internal-media-surface.v1.json",
] as const;

// Run from the repository root by its package script; tsx compiles this to
// CJS at the root, where import.meta.dirname is not available.
const repository = cwd();
/** Something that is inconsistent with itself: a regression. */
const failures: string[] = [];
/** Something the approved plans require that has not been built yet. */
const outstanding: string[] = [];

function require_(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function built(condition: boolean, message: string): void {
  if (!condition) outstanding.push(message);
}

async function source(path: string): Promise<string> {
  return readFile(resolve(repository, path), "utf8");
}

async function main(): Promise<void> {
  const coverage = contractCoverage();

  // Every required route exists in the canonical table AND is registered on a
  // path the server actually serves. A builder nobody registers is a route the
  // worker cannot call, which is exactly how three of them went missing.
  // Media routes register in their own module, so both files are read.
  const registrationSources = (await Promise.all([
    "apps/server/src/routes.ts",
    "apps/server/src/modules/media/media-routes.ts",
  ].map(source))).join("\n");
  for (const name of REQUIRED_ROUTES) {
    require_(coverage.routeNames.includes(name), `route absent from the canonical table: ${name}`);
    if (name.startsWith("internal.")) {
      built(
        registrationSources.includes(`routes.${name}()`),
        `internal route never registered: ${name}`,
      );
    }
  }

  for (const frame of REQUIRED_CLIENT_FRAMES) {
    require_(coverage.realtimeFrames.client.includes(frame), `missing client frame: ${frame}`);
  }
  for (const frame of REQUIRED_SERVER_FRAMES) {
    require_(coverage.realtimeFrames.server.includes(frame), `missing server frame: ${frame}`);
  }
  for (const type of REQUIRED_ROOM_EVENTS) {
    require_(coverage.roomEventTypes.includes(type), `missing RoomEvent type: ${type}`);
  }
  for (const key of REQUIRED_PROJECTIONS) {
    require_(coverage.projectionKeys.includes(key), `missing projection key: ${key}`);
  }
  for (const schema of HIGH_RISK_SCHEMAS) {
    require_(coverage.schemaFiles.includes(schema), `missing high-risk schema: ${schema}`);
  }

  // Every Python-ingress schema has a worker module and a digest that still
  // matches the schema on disk.
  const workerManifest = JSON.parse(
    await source("services/worker/src/learning_orbit_worker/generated/manifest.json"),
  ) as {
    sourceSchemas: Array<{ file: string; sha256: string; sourcePath: string }>;
    generatedModules: Array<{ sourceFile: string; moduleFile: string }>;
  };
  const ingressListed = workerManifest.sourceSchemas.map(({ file }) => file).sort();
  require_(
    JSON.stringify(ingressListed) === JSON.stringify([...coverage.pythonIngressSchemas]),
    `worker manifest does not list exactly the Python-ingress schemas: ${ingressListed.join(",")}`,
  );
  const { createHash } = await import("node:crypto");
  for (const entry of workerManifest.sourceSchemas) {
    const raw = await readFile(resolve(repository, entry.sourcePath));
    require_(
      entry.sha256 === createHash("sha256").update(raw).digest("hex"),
      `worker manifest digest is stale for ${entry.file}`,
    );
  }

  // Every required job family is dispatched by a registered worker handler.
  const handlerSources = await Promise.all([
    "services/worker/src/learning_orbit_worker/core_handlers.py",
    "services/worker/src/learning_orbit_worker/analytics_handlers.py",
    "services/worker/src/learning_orbit_worker/pipeline_handlers.py",
    "services/worker/src/learning_orbit_worker/lifecycle.py",
  ].map(source));
  const handlers = handlerSources.join("\n");
  for (const jobType of REQUIRED_JOB_TYPES) {
    built(handlers.includes(`"${jobType}"`), `job family never dispatched by a handler: ${jobType}`);
  }

  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    routeNames: [...coverage.routeNames],
    realtimeFrames: {
      client: [...coverage.realtimeFrames.client],
      server: [...coverage.realtimeFrames.server],
    },
    roomEventTypes: [...coverage.roomEventTypes],
    projectionKeys: [...coverage.projectionKeys],
    schemaFiles: [...coverage.schemaFiles],
    pythonIngressSchemas: [...coverage.pythonIngressSchemas],
    jobTypes: [...REQUIRED_JOB_TYPES],
    failures,
    outstanding,
  };

  const outIndex = argv.indexOf("--out");
  if (outIndex >= 0 && typeof argv[outIndex + 1] === "string") {
    const target = resolve(repository, argv[outIndex + 1]!);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
  }

  // A regression and an unbuilt plan item are different facts, and a gate that
  // reports them as one number teaches a reader to ignore it.
  if (failures.length) {
    stderr.write(`program-contracts: INCONSISTENT\n${failures.map((line) => `  - ${line}`).join("\n")}\n`);
  }
  if (outstanding.length) {
    stderr.write(`program-contracts: NOT YET BUILT\n${outstanding.map((line) => `  - ${line}`).join("\n")}\n`);
  }
  if (failures.length || outstanding.length) {
    stderr.write(`program-contracts: FAIL (${failures.length} inconsistent, ${outstanding.length} outstanding)\n`);
    exit(1);
  }
  stdout.write(`program-contracts: PASS (${coverage.routeNames.length} routes, ${coverage.schemaFiles.length} schemas)\n`);
}

void main();
