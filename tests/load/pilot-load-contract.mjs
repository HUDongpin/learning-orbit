import { createHash } from "node:crypto";

export const PILOT_FIXTURE = Object.freeze({
  rooms: 10,
  studentsPerRoom: 4,
  teachersPerRoom: 1,
  studentClients: 40,
  teacherClients: 10,
  teacherSessions: 1,
  concurrentClients: 50,
  reconnects: 50,
  messageRounds: 2,
});

export const PILOT_TARGETS = Object.freeze({
  textAckP95Ms: 750,
  textAckP99Ms: 1_500,
  outboxP95Ms: 1_000,
  deterministicProjectionP95Ms: 3_000,
});

export const PILOT_CLAIM_BOUNDARY =
  "Local controlled engineering fixture for this source commit; not a production SLA or learning-effect claim.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const IMAGE = /^[a-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/;
const REPORT_KEYS = [
  "backpressure", "claimBoundary", "commandsSent", "committedEventLoss", "committedEvents",
  "concurrentClients", "deterministicProjectionLagMs", "duplicateCommittedEvents", "environment",
  "errorRate", "fixture", "maxConcurrentClients", "messageRounds", "ok", "outboxLagMs",
  "projectionEdges", "projectionNodes", "providerChecks", "providerMode", "reconnects", "replayMs",
  "roomSeqGaps", "rooms", "schemaVersion", "sourceSha", "studentClients", "studentsPerRoom",
  "teacherClients", "teacherSessions", "teachersPerRoom", "textAckMs", "websocket",
];
const METRIC_KEYS = ["p50", "p95", "p99", "samples"];

function fail() {
  throw new Error("PILOT_LOAD_REPORT_INVALID");
}

function plain(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  return plain(value)
    && Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function metric(value, expectedSamples) {
  if (!exactKeys(value, METRIC_KEYS) || value.samples !== expectedSamples
    || !finite(value.p50) || !finite(value.p95) || !finite(value.p99)
    || value.p50 > value.p95 || value.p95 > value.p99) fail();
  return value;
}

export function deterministicJitterSeconds(clientIndex, round) {
  if (!Number.isSafeInteger(clientIndex) || clientIndex < 0 || clientIndex >= PILOT_FIXTURE.studentClients
    || !Number.isSafeInteger(round) || round < 0 || round >= PILOT_FIXTURE.messageRounds) {
    throw new Error("PILOT_LOAD_JITTER_INPUT_INVALID");
  }
  return 8 + ((clientIndex * 7 + round * 11) % 13);
}

export function deterministicUuid(seed) {
  if (typeof seed !== "string" || seed.length < 1 || seed.length > 512 || seed.includes("\u0000")) {
    throw new Error("PILOT_LOAD_UUID_SEED_INVALID");
  }
  const bytes = createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildLocalWebSocketUrl(origin, route) {
  if (origin !== "https://127.0.0.1:3000" || typeof route !== "string"
    || !/^\/v1\/rooms\/[0-9a-f-]{36}\/realtime$/.test(route)) {
    throw new Error(origin === "https://127.0.0.1:3000"
      ? "PILOT_LOAD_WEBSOCKET_URL_INVALID"
      : "PILOT_LOAD_ORIGIN_INVALID");
  }
  const url = new URL(route, origin);
  url.protocol = "wss:";
  if (url.origin !== "wss://127.0.0.1:3000" || url.search !== "" || url.hash !== ""
    || url.username !== "" || url.password !== "") {
    throw new Error("PILOT_LOAD_WEBSOCKET_URL_INVALID");
  }
  return url.href;
}

function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function rounded(value) {
  return Math.round(value * 1_000) / 1_000;
}

export function summarizeMilliseconds(samples) {
  if (!Array.isArray(samples) || samples.length === 0
    || samples.some((value) => !finite(value))) {
    throw new Error("PILOT_LOAD_MEASUREMENTS_INVALID");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return Object.freeze({
    samples: sorted.length,
    p50: rounded(percentile(sorted, 0.50)),
    p95: rounded(percentile(sorted, 0.95)),
    p99: rounded(percentile(sorted, 0.99)),
  });
}

function admitted(value) {
  return value.maxConcurrentClients === PILOT_FIXTURE.concurrentClients
    && value.reconnects === PILOT_FIXTURE.reconnects
    && value.commandsSent === PILOT_FIXTURE.studentClients * PILOT_FIXTURE.messageRounds
    && value.committedEventLoss === 0
    && value.duplicateCommittedEvents === 0
    && value.roomSeqGaps === 0
    && value.errorRate === 0
    && value.textAckMs.p95 <= PILOT_TARGETS.textAckP95Ms
    && value.textAckMs.p99 <= PILOT_TARGETS.textAckP99Ms
    && value.outboxLagMs.p95 <= PILOT_TARGETS.outboxP95Ms
    && value.deterministicProjectionLagMs.p95 <= PILOT_TARGETS.deterministicProjectionP95Ms
    && value.providerChecks.media === "MEDIA_SERVICE_UNAVAILABLE"
    && value.providerChecks.agent === "AGENT_SERVICE_UNAVAILABLE"
    && value.backpressure.snapshotRequired + value.backpressure.controlledCloses >= 1;
}

export function buildPilotReport(input) {
  const report = {
    schemaVersion: 1,
    ok: false,
    fixture: "controlled-pilot",
    claimBoundary: PILOT_CLAIM_BOUNDARY,
    sourceSha: input.sourceSha,
    ...PILOT_FIXTURE,
    maxConcurrentClients: input.maxConcurrentClients,
    reconnects: input.reconnects,
    commandsSent: input.commandsSent,
    committedEvents: input.committedEvents,
    committedEventLoss: input.committedEventLoss,
    duplicateCommittedEvents: input.duplicateCommittedEvents,
    roomSeqGaps: input.roomSeqGaps,
    providerMode: "disabled",
    providerChecks: input.providerChecks,
    websocket: {
      protocol: "wss:",
      sameOrigin: true,
      credentialQuery: false,
    },
    textAckMs: input.textAckMs,
    outboxLagMs: input.outboxLagMs,
    deterministicProjectionLagMs: input.deterministicProjectionLagMs,
    replayMs: input.replayMs,
    projectionNodes: input.projectionNodes,
    projectionEdges: input.projectionEdges,
    errorRate: input.errorRate,
    backpressure: input.backpressure,
    environment: input.environment,
  };
  report.ok = admitted(report);
  return Object.freeze(report);
}

export function validatePilotReport(value) {
  if (!exactKeys(value, REPORT_KEYS) || value.schemaVersion !== 1
    || value.fixture !== "controlled-pilot" || value.claimBoundary !== PILOT_CLAIM_BOUNDARY
    || !SHA.test(value.sourceSha ?? "")
    || value.rooms !== 10 || value.studentsPerRoom !== 4 || value.teachersPerRoom !== 1
    || value.studentClients !== 40 || value.teacherClients !== 10 || value.teacherSessions !== 1
    || value.concurrentClients !== 50
    || value.messageRounds !== 2 || !count(value.maxConcurrentClients) || value.maxConcurrentClients > 50
    || !count(value.reconnects) || value.reconnects > 50
    || value.commandsSent !== 80 || !count(value.committedEvents) || value.committedEvents < value.commandsSent
    || !count(value.committedEventLoss) || !count(value.duplicateCommittedEvents) || !count(value.roomSeqGaps)
    || value.providerMode !== "disabled" || !exactKeys(value.providerChecks, ["agent", "media"])
    || !["MEDIA_SERVICE_UNAVAILABLE", "UNEXPECTED_PROVIDER_AVAILABLE", "PROVIDER_CHECK_FAILED"].includes(value.providerChecks.media)
    || !["AGENT_SERVICE_UNAVAILABLE", "UNEXPECTED_PROVIDER_AVAILABLE", "PROVIDER_CHECK_FAILED"].includes(value.providerChecks.agent)
    || !exactKeys(value.websocket, ["credentialQuery", "protocol", "sameOrigin"])
    || value.websocket.protocol !== "wss:" || value.websocket.sameOrigin !== true
    || value.websocket.credentialQuery !== false
    || !count(value.projectionNodes) || !count(value.projectionEdges)
    || !finite(value.errorRate) || value.errorRate > 1
    || !exactKeys(value.backpressure, ["controlledCloses", "snapshotRequired"])
    || !count(value.backpressure.controlledCloses) || !count(value.backpressure.snapshotRequired)
    || !exactKeys(value.environment, ["arch", "cpuCount", "mailpitImage", "node", "platform", "postgresImage"])
    || value.environment.node !== "v24.19.0"
    || !["darwin", "linux"].includes(value.environment.platform)
    || !["arm64", "x64"].includes(value.environment.arch)
    || !Number.isSafeInteger(value.environment.cpuCount) || value.environment.cpuCount < 1
    || !IMAGE.test(value.environment.postgresImage ?? "")
    || !IMAGE.test(value.environment.mailpitImage ?? "")) fail();
  metric(value.textAckMs, 80);
  metric(value.outboxLagMs, 80);
  metric(value.deterministicProjectionLagMs, 20);
  metric(value.replayMs, 50);
  if (typeof value.ok !== "boolean" || value.ok !== admitted(value)) fail();
  return value;
}
