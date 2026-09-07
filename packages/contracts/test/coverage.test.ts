import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { contractCoverage } from "../src/coverage.js";
import generatedManifest from "../src/generated/manifest.json" with { type: "json" };

const SCHEMAS = new URL("../schemas/", import.meta.url);

describe("contract coverage manifest", () => {
  it("lists every canonical schema on disk, and only those", async () => {
    const onDisk = (await readdir(SCHEMAS)).filter((file) => file.endsWith(".json")).sort();
    // Derived, not restated: a schema added without regenerating shows up here
    // rather than at some later gate that has its own hand-written list.
    expect([...contractCoverage().schemaFiles]).toEqual(onDisk);
  });

  it("carries a digest that still matches the schema it names", async () => {
    for (const source of generatedManifest.sourceSchemas) {
      const raw = await readFile(new URL(source.file, SCHEMAS));
      expect(source.sha256).toBe(createHash("sha256").update(raw).digest("hex"));
    }
  });

  it("names every route the canonical table exposes", () => {
    const { routeNames } = contractCoverage();
    for (const required of [
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
    ]) {
      expect(routeNames).toContain(required);
    }
    expect(new Set(routeNames).size).toBe(routeNames.length);
  });

  it("derives both realtime frame unions from the schema itself", () => {
    const { realtimeFrames } = contractCoverage();
    expect([...realtimeFrames.client])
      .toEqual(["command", "heartbeat", "hello", "presence", "typing"]);
    for (const frame of [
      "welcome", "ack", "reject", "event", "presence", "typing",
      "projection", "media_status", "agent_status",
      "resume_complete", "snapshot_required", "degraded", "heartbeat",
    ]) {
      expect(realtimeFrames.server).toContain(frame);
    }
  });

  it("names every RoomEvent type and projection key the programme requires", () => {
    const { roomEventTypes, projectionKeys } = contractCoverage();
    for (const type of [
      "room.opened", "room.paused", "room.resumed", "room.closed",
      "message.added", "message.revised", "message.retracted",
      "analytics.review.recorded.v1", "analytics.correction.recorded.v1",
    ]) {
      expect(roomEventTypes).toContain(type);
    }
    expect([...projectionKeys]).toEqual([
      "echo.student_approved", "echo.teacher_shadow",
      "trace.student_bundle", "trace.teacher_bundle",
    ]);
  });

  it("agrees with the generator about which schemas the worker must parse", async () => {
    const declared: string[] = [];
    for (const file of (await readdir(SCHEMAS)).filter((name) => name.endsWith(".json"))) {
      const schema = JSON.parse(await readFile(new URL(file, SCHEMAS), "utf8"));
      if (schema["x-learning-orbit-python-ingress"] === true) declared.push(file);
    }
    expect([...contractCoverage().pythonIngressSchemas]).toEqual(declared.sort());
  });
});
