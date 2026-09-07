import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildPilotReport,
  PILOT_TARGETS,
  summarizeMilliseconds,
} from "../load/pilot-load-contract.mjs";

const execFileAsync = promisify(execFile);
const REPOSITORY = resolve(import.meta.dirname, "../..");
const temporaries: string[] = [];

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Sample counts are pinned by the contract: 80 acks, 20 projections, 50 replays. */
function metric(value: number, samples: number) {
  return summarizeMilliseconds(Array.from({ length: samples }, () => value));
}

/** A report the harness itself would consider well-formed and admitted. */
function report(overrides: Record<string, unknown> = {}) {
  return buildPilotReport({
    sourceSha: "0".repeat(40),
    maxConcurrentClients: 50,
    reconnects: 0,
    commandsSent: 80,
    committedEvents: 80,
    committedEventLoss: 0,
    duplicateCommittedEvents: 0,
    roomSeqGaps: 0,
    providerChecks: {
      media: "MEDIA_SERVICE_UNAVAILABLE",
      agent: "AGENT_SERVICE_UNAVAILABLE",
    },
    textAckMs: metric(120, 80),
    outboxLagMs: metric(90, 80),
    deterministicProjectionLagMs: metric(900, 20),
    replayMs: metric(20, 50),
    projectionNodes: 10,
    projectionEdges: 10,
    errorRate: 0,
    backpressure: { snapshotRequired: 1, controlledCloses: 0 },
    environment: {
      node: "v24.19.0",
      platform: "darwin",
      arch: "arm64",
      cpuCount: 8,
      postgresImage: "postgres:18@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280",
      mailpitImage: "axllent/mailpit:v1.31.0@sha256:c96991d9bef73594c246d89ca81411d4e916f03e76a7d2d72fa2ab5dd3c9ce24",
    },
    ...overrides,
  });
}

async function assertReport(value: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "lo-load-assert-"));
  temporaries.push(directory);
  const file = join(directory, "pilot-load.json");
  await writeFile(file, JSON.stringify(value));
  try {
    const { stdout } = await execFileAsync(
      "pnpm", ["exec", "tsx", "tests/load/assert-pilot-results.ts", file],
      { cwd: REPOSITORY, encoding: "utf8", timeout: 120_000 },
    );
    return { ok: true as const, stdout };
  } catch (error) {
    return { ok: false as const, stderr: String((error as { stderr?: string }).stderr ?? "") };
  }
}

describe("pilot load assertion", () => {
  it("accepts the report the harness actually produces", async () => {
    // The previous version of this script looked for a `measurements` array
    // and a `teacherPerRoom` field, neither of which the harness has ever
    // emitted, so the load gate could only fail and asserted nothing.
    const result = await assertReport(report());
    expect(result.ok).toBe(true);
    const summary = JSON.parse(result.ok ? result.stdout : "{}");
    expect(summary).toMatchObject({
      ok: true,
      fixture: "controlled-pilot",
      rooms: 10,
      studentsPerRoom: 4,
      teachersPerRoom: 1,
      errorRate: 0,
    });
    expect(summary.claimBoundary).toContain("not a production SLA");
  }, 180_000);

  it("names the target a slow run missed instead of only calling it invalid", async () => {
    const slow = await assertReport(report({
      textAckMs: metric(PILOT_TARGETS.textAckP95Ms + 250, 80),
    }));
    expect(slow.ok).toBe(false);
    expect(slow.ok === false && slow.stderr).toContain("text ack p95");
  }, 180_000);

  it("refuses a run that lost or duplicated a committed event", async () => {
    for (const overrides of [
      { committedEventLoss: 1 },
      { duplicateCommittedEvents: 1 },
      { roomSeqGaps: 1 },
      { errorRate: 0.01 },
    ]) {
      const result = await assertReport(report(overrides));
      expect(result.ok).toBe(false);
    }
  }, 180_000);

  it("refuses a report that is not the harness's own shape", async () => {
    for (const value of [
      {},
      { fixture: "controlled-pilot", measurements: [] },
      { ...report(), fixture: "something-else" },
    ]) {
      const result = await assertReport(value);
      expect(result.ok).toBe(false);
    }
  }, 180_000);
});
