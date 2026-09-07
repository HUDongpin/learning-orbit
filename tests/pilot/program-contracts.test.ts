import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const REPOSITORY = resolve(import.meta.dirname, "../..");
const REPORT = resolve(REPOSITORY, "test-results/program-contracts.json");

interface Report {
  schemaVersion: number;
  routeNames: string[];
  realtimeFrames: { client: string[]; server: string[] };
  roomEventTypes: string[];
  projectionKeys: string[];
  schemaFiles: string[];
  pythonIngressSchemas: string[];
  jobTypes: string[];
  failures: string[];
  outstanding: string[];
}

async function runGate(): Promise<Report> {
  try {
    await execFileAsync("pnpm", ["exec", "tsx", "scripts/assert-program-contracts.ts", "--out", REPORT], {
      cwd: REPOSITORY, encoding: "utf8", timeout: 120_000,
    });
  } catch {
    // The gate exits non-zero while the programme is incomplete. The report is
    // written either way, and it is the report this test is about.
  }
  return JSON.parse(await readFile(REPORT, "utf8")) as Report;
}

afterAll(async () => rm(REPORT, { force: true }));

describe("program contract gate", () => {
  it("finds nothing inconsistent between the plans and this build", async () => {
    const report = await runGate();
    // An inconsistency is a regression: a route in the table nobody registered,
    // a worker digest that no longer matches its schema, a missing frame.
    // Anything not yet built is reported separately and is not a regression.
    expect(report.failures).toEqual([]);
  }, 180_000);

  it("names what the programme still requires and has not built", async () => {
    const report = await runGate();
    // Every outstanding item must be a required job family or route, never a
    // vague note: the gate is the list of what is left, so it has to be exact.
    for (const item of report.outstanding) {
      expect(item).toMatch(/^(job family never dispatched by a handler|internal route never registered): [a-z0-9.\-]+$/);
    }
  }, 180_000);

  it("records the whole surface it checked, so the report stands alone", async () => {
    const report = await runGate();
    expect(report.schemaVersion).toBe(1);
    expect(report.routeNames.length).toBeGreaterThanOrEqual(30);
    expect(report.realtimeFrames.client).toContain("hello");
    expect(report.realtimeFrames.server).toContain("degraded");
    expect(report.roomEventTypes).toContain("message.added");
    expect(report.projectionKeys).toContain("trace.student_bundle");
    expect(report.schemaFiles).toContain("realtime-frame.v1.json");
    expect(report.pythonIngressSchemas).toContain("media-internal-outcome.v1.json");
    expect(report.jobTypes).toContain("room.delete-surface.v1");
  }, 180_000);
});
