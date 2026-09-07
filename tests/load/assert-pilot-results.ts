#!/usr/bin/env -S pnpm tsx
/**
 * Assert a load report against the contract the harness actually emits.
 *
 * This script previously checked for a `measurements` array and a
 * `teacherPerRoom` field, neither of which the harness has ever produced - the
 * report carries `textAckMs`, `outboxLagMs` and `teachersPerRoom`. It could
 * therefore only ever fail, so the load gate was asserting nothing about the
 * numbers it was supposed to be guarding.
 *
 * There is now one contract. `validatePilotReport` already owns the report's
 * exact shape and the pilot's latency targets; this script reads the file,
 * hands it to that validator, and prints the numbers a reader has to see.
 *
 *   pnpm tsx tests/load/assert-pilot-results.ts test-results/pilot-load.json
 */
import { readFile } from "node:fs/promises";
import { argv, exit, stderr, stdout } from "node:process";

// The load harness is plain ESM shared with the runner.
import { PILOT_CLAIM_BOUNDARY, PILOT_TARGETS, validatePilotReport } from "./pilot-load-contract.mjs";

interface Metric {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly samples: number;
}

interface PilotReport {
  readonly fixture: string;
  readonly ok: boolean;
  readonly rooms: number;
  readonly studentsPerRoom: number;
  readonly teachersPerRoom: number;
  readonly errorRate: number;
  readonly committedEventLoss: number;
  readonly duplicateCommittedEvents: number;
  readonly roomSeqGaps: number;
  readonly textAckMs: Metric;
  readonly outboxLagMs: Metric;
  readonly deterministicProjectionLagMs: Metric;
}

async function main(): Promise<void> {
  const file = argv[2];
  if (!file) {
    stderr.write("usage: assert-pilot-results <report.json>\n");
    exit(2);
  }
  let report: PilotReport;
  try {
    report = JSON.parse(await readFile(file, "utf8")) as PilotReport;
  } catch {
    stderr.write("PILOT_LOAD_REPORT_UNREADABLE\n");
    exit(1);
    return;
  }

  try {
    validatePilotReport(report);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : "PILOT_LOAD_REPORT_INVALID"}\n`);
    exit(1);
    return;
  }

  // The validator already refuses a report that misses a target, but the
  // failures are stated here too: a gate that only says "invalid" makes a
  // slow run indistinguishable from a malformed one.
  const failures: string[] = [];
  if (report.errorRate !== 0) failures.push(`errorRate ${report.errorRate} is not zero`);
  if (report.committedEventLoss !== 0) failures.push(`lost ${report.committedEventLoss} committed events`);
  if (report.duplicateCommittedEvents !== 0) failures.push(`${report.duplicateCommittedEvents} duplicate committed events`);
  if (report.roomSeqGaps !== 0) failures.push(`${report.roomSeqGaps} gaps in roomSeq`);
  if (report.textAckMs.p95 > PILOT_TARGETS.textAckP95Ms) {
    failures.push(`text ack p95 ${report.textAckMs.p95}ms over ${PILOT_TARGETS.textAckP95Ms}ms`);
  }
  if (report.textAckMs.p99 > PILOT_TARGETS.textAckP99Ms) {
    failures.push(`text ack p99 ${report.textAckMs.p99}ms over ${PILOT_TARGETS.textAckP99Ms}ms`);
  }
  if (report.outboxLagMs.p95 > PILOT_TARGETS.outboxP95Ms) {
    failures.push(`outbox lag p95 ${report.outboxLagMs.p95}ms over ${PILOT_TARGETS.outboxP95Ms}ms`);
  }
  if (report.deterministicProjectionLagMs.p95 > PILOT_TARGETS.deterministicProjectionP95Ms) {
    failures.push(`projection lag p95 ${report.deterministicProjectionLagMs.p95}ms over ${PILOT_TARGETS.deterministicProjectionP95Ms}ms`);
  }

  if (failures.length) {
    stderr.write(`pilot-load: FAIL\n${failures.map((line) => `  - ${line}`).join("\n")}\n`);
    exit(1);
    return;
  }

  stdout.write(`${JSON.stringify({
    ok: true,
    fixture: report.fixture,
    rooms: report.rooms,
    studentsPerRoom: report.studentsPerRoom,
    teachersPerRoom: report.teachersPerRoom,
    errorRate: report.errorRate,
    textAckP95Ms: report.textAckMs.p95,
    outboxLagP95Ms: report.outboxLagMs.p95,
    projectionLagP95Ms: report.deterministicProjectionLagMs.p95,
    claimBoundary: PILOT_CLAIM_BOUNDARY,
  })}\n`);
}

void main();
