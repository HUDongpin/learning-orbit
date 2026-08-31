#!/usr/bin/env node

import { execFile } from "node:child_process";
import { cpus } from "node:os";
import { arch, platform } from "node:process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { MailpitClient, parseMagicLinkFromMessage } from "../../scripts/local-pilot/mailpit.mjs";
import { MAILPIT_IMAGE, POSTGRES_IMAGE } from "../../scripts/local-pilot/preflight.mjs";
import {
  PILOT_FIXTURE,
  buildPilotReport,
  deterministicJitterSeconds,
  deterministicUuid,
  summarizeMilliseconds,
  validatePilotReport,
} from "./pilot-load-contract.mjs";
import {
  LocalHttpsClient,
  assertProviderDisabled,
  derivePilotRunIdentity,
  extractOpaqueSessionCookie,
  loadPilotCaFile,
} from "./pilot-load-http.mjs";
import { LoadConnectionTracker, PilotWebSocketClient } from "./pilot-load-websocket.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TOPIC = "生態系統探究";
const NORMAL_COMMANDS = PILOT_FIXTURE.studentClients * PILOT_FIXTURE.messageRounds;
// Each encoded synthetic event is about 10 KiB.  Six hundred and forty
// events exceed macOS's 4 MiB auto receive-buffer ceiling plus the server's
// 1 MiB close threshold, so a paused client deterministically exercises the
// real WebSocket backpressure path instead of fitting entirely in the kernel.
const BACKPRESSURE_COMMANDS = 640;
// A 64-event page remains below LocalHttpsClient's 1 MiB response ceiling
// even when it contains the largest synthetic backpressure messages.
const EVENT_PAGE_LIMIT = 64;

function fail(code) {
  throw new Error(code);
}

function stableCode(error) {
  const message = error instanceof Error ? error.message : "";
  return /^((?:PILOT_LOAD|MAILPIT)_[A-Z0-9_]+)/.exec(message)?.[1] ?? "PILOT_LOAD_FAILED";
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitUntil(check, { code, timeoutMs = 15_000, intervalMs = 100 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(intervalMs);
  }
  fail(code);
}

function assertStatus(response, expected, code) {
  if (!response || response.status !== expected) fail(code);
  return response;
}

async function sourceSha() {
  try {
    const { stdout } = await execFileAsync("git", [
      "-c", "core.hooksPath=/dev/null", "-C", root, "rev-parse", "HEAD",
    ], {
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      env: {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    const sha = stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) fail("PILOT_LOAD_SOURCE_SHA_INVALID");
    return sha;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("PILOT_LOAD_")) throw error;
    fail("PILOT_LOAD_SOURCE_SHA_INVALID");
  }
}

async function loadRuntimeDependencies() {
  try {
    const serverRequire = createRequire(resolve(root, "apps/server/package.json"));
    const contracts = await import(pathToFileURL(
      serverRequire.resolve("@learning-orbit/contracts"),
    ).href);
    const imported = serverRequire("ws");
    const WebSocketImpl = imported.WebSocket ?? imported;
    if (!contracts.routes || !contracts.authContract || !contracts.roomHttpContract
      || !contracts.realtimeContract || !contracts.analyticsContract
      || typeof WebSocketImpl !== "function") fail("PILOT_LOAD_RUNTIME_INVALID");
    return { contracts, WebSocketImpl };
  } catch (error) {
    if (error instanceof Error && error.message === "PILOT_LOAD_RUNTIME_INVALID") throw error;
    fail("PILOT_LOAD_RUNTIME_INVALID");
  }
}

async function provisionTeacher(databaseUrl, address) {
  const executable = resolve(root, "apps/server/dist/src/teacher-provision-cli.js");
  try {
    const result = await execFileAsync(process.execPath, [executable, "--email", address], {
      cwd: root,
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      env: {
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? "",
        DATABASE_URL: databaseUrl,
      },
    });
    if (!/^inserted: [01]\n$/.test(result.stdout) || result.stderr !== "") {
      fail("PILOT_LOAD_TEACHER_PROVISION_FAILED");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "PILOT_LOAD_TEACHER_PROVISION_FAILED") throw error;
    fail("PILOT_LOAD_TEACHER_PROVISION_FAILED");
  }
}

async function teacherSession({ http, contracts, address, mailpit }) {
  await mailpit.deleteRecipientMessages(address);
  await mailpit.assertRecipientEmpty(address);
  const accepted = assertStatus(await http.send({
    method: "POST",
    path: contracts.routes.auth.teacherMagicLink(),
    body: { email: address },
  }), 202, "PILOT_LOAD_MAGIC_LINK_REQUEST_FAILED");
  contracts.authContract.parseTeacherMagicLinkAccepted(accepted.body);
  let messageId;
  await waitUntil(async () => {
    try {
      messageId = await mailpit.findSingleMessage(address);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === "MAILPIT_MESSAGE_NOT_READY") return false;
      throw error;
    }
  }, { code: "PILOT_LOAD_MAGIC_LINK_NOT_DELIVERED" });
  try {
    const message = await mailpit.readMessage(messageId);
    const link = new URL(parseMagicLinkFromMessage(message));
    const consumed = assertStatus(await http.send({
      method: "GET",
      path: `${link.pathname}${link.search}`,
    }), 303, "PILOT_LOAD_MAGIC_LINK_CONSUME_FAILED");
    if (consumed.headers.location !== "/teacher") fail("PILOT_LOAD_MAGIC_LINK_CONSUME_FAILED");
    const cookie = extractOpaqueSessionCookie(consumed.headers["set-cookie"]);
    const sessionResponse = assertStatus(await http.send({
      method: "GET", path: contracts.routes.auth.session(), cookie,
    }), 200, "PILOT_LOAD_SESSION_FAILED");
    const session = contracts.authContract.parseSession(sessionResponse.body);
    if (session.role !== "teacher") fail("PILOT_LOAD_SESSION_FAILED");
    return { cookie, session };
  } finally {
    await mailpit.deleteRecipientMessages(address);
    await mailpit.assertRecipientEmpty(address);
  }
}

async function createClassrooms({ http, contracts, teacherCookie }) {
  const created = [];
  for (let roomIndex = 0; roomIndex < PILOT_FIXTURE.rooms; roomIndex += 1) {
    const response = assertStatus(await http.send({
      method: "POST",
      path: contracts.routes.rooms.create(),
      cookie: teacherCookie,
      body: { topic: TOPIC },
    }), 201, "PILOT_LOAD_ROOM_CREATE_FAILED");
    const value = contracts.roomHttpContract.parseCreateRoomResponse(response.body);
    created.push({
      roomIndex,
      roomId: value.room.roomId,
      roomCode: value.room.roomCode,
      seats: value.seatInvites.map((seat, seatIndex) => ({ seatIndex, seatCode: seat.code })),
    });
  }
  if (new Set(created.map(({ roomId }) => roomId)).size !== PILOT_FIXTURE.rooms) {
    fail("PILOT_LOAD_ROOM_CREATE_FAILED");
  }
  return created;
}

async function joinStudents({ http, contracts, classrooms }) {
  const joined = await Promise.all(classrooms.flatMap((room) => room.seats.map(async (seat) => {
    const response = assertStatus(await http.send({
      method: "POST",
      path: contracts.routes.rooms.join(),
      body: { roomCode: room.roomCode, seatCode: seat.seatCode },
    }), 200, "PILOT_LOAD_STUDENT_JOIN_FAILED");
    const cookie = extractOpaqueSessionCookie(response.headers["set-cookie"]);
    const join = contracts.roomHttpContract.parseJoinRoomResponse(response.body);
    const hydrated = assertStatus(await http.send({
      method: "GET", path: contracts.routes.auth.session(), cookie,
    }), 200, "PILOT_LOAD_STUDENT_SESSION_FAILED");
    const session = contracts.authContract.parseSession(hydrated.body);
    if (session.role !== "student" || session.roomId !== room.roomId
      || session.roomMemberId !== join.roomMemberId || session.actorId !== join.actorId
      || session.pseudonym !== join.pseudonym) {
      fail("PILOT_LOAD_STUDENT_SESSION_FAILED");
    }
    return {
      roomIndex: room.roomIndex,
      seatIndex: seat.seatIndex,
      roomId: room.roomId,
      cookie,
      session,
    };
  })));
  if (joined.length !== PILOT_FIXTURE.studentClients
    || new Set(joined.map(({ cookie }) => cookie)).size !== PILOT_FIXTURE.studentClients) {
    fail("PILOT_LOAD_STUDENT_JOIN_FAILED");
  }
  // One-time room and seat codes intentionally become unreachable here.
  for (const room of classrooms) {
    room.roomCode = undefined;
    room.seats = undefined;
  }
  return joined;
}

function roomCommand({ runId, roomId, type, suffix, payload = {} }) {
  return {
    commandId: deterministicUuid(`${runId}:${type}:${suffix}`),
    roomId,
    type,
    clientTime: new Date().toISOString(),
    payload,
  };
}

async function getAllEvents({ http, contracts, roomId, cookie }) {
  const events = [];
  let afterSeq = 0;
  for (let page = 0; page < 16; page += 1) {
    const response = assertStatus(await http.send({
      method: "GET",
      path: contracts.routes.rooms.events(roomId, { afterSeq, limit: EVENT_PAGE_LIMIT }),
      cookie,
    }), 200, "PILOT_LOAD_EVENT_PAGE_FAILED");
    const result = contracts.roomHttpContract.parseRoomEventPage(response.body);
    events.push(...result.events);
    if (result.nextAfterSeq === undefined) return events;
    if (result.nextAfterSeq <= afterSeq) fail("PILOT_LOAD_EVENT_PAGE_FAILED");
    afterSeq = result.nextAfterSeq;
  }
  fail("PILOT_LOAD_EVENT_PAGE_FAILED");
}

async function pollProjection({ http, contracts, roomId, cookie, projectionKey, targetSeq, startedAt }) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await http.send({
      method: "GET",
      path: contracts.routes.analytics.latest(roomId, projectionKey),
      cookie,
    });
    if (response.status === 404) {
      await sleep(100);
      continue;
    }
    assertStatus(response, 200, "PILOT_LOAD_PROJECTION_FAILED");
    const projection = projectionKey === "echo.teacher_shadow"
      ? contracts.analyticsContract.parseTeacherEchoSnapshot(response.body)
      : contracts.analyticsContract.parseTrace(response.body);
    if (projection.completeThroughRoomSeq < targetSeq) {
      await sleep(100);
      continue;
    }
    if (projectionKey === "echo.teacher_shadow") {
      return {
        lagMs: Math.max(0, performance.now() - startedAt),
        nodes: projection.payload.nodes.length,
        edges: projection.payload.edges.length,
      };
    }
    const view = projection.payload.windows.session_45m.views.observed;
    return {
      lagMs: Math.max(0, performance.now() - startedAt),
      nodes: view.nodes.length,
      edges: view.edges.length,
    };
  }
  fail("PILOT_LOAD_PROJECTION_TIMEOUT");
}

async function run() {
  if (process.version !== "v24.19.0") fail("PILOT_LOAD_NODE_VERSION_MISMATCH");
  if (process.env.LO_PUBLIC_BASE_ORIGIN !== "https://127.0.0.1:3000") {
    fail("PILOT_LOAD_ORIGIN_INVALID");
  }
  const databaseUrl = process.env.DATABASE_URL;
  const caFile = process.env.LO_PILOT_TLS_CA_FILE;
  if (!databaseUrl || !caFile || !isAbsolute(caFile)) fail("PILOT_LOAD_CONFIG_INVALID");
  const identity = derivePilotRunIdentity(databaseUrl);
  const ca = await loadPilotCaFile(caFile);
  const { contracts, WebSocketImpl } = await loadRuntimeDependencies();
  const http = new LocalHttpsClient({ ca });
  const mailpit = new MailpitClient();
  const sha = await sourceSha();
  await provisionTeacher(databaseUrl, identity.teacherAddress);
  const teacher = await teacherSession({
    http, contracts, address: identity.teacherAddress, mailpit,
  });

  const cookies = new Set([teacher.cookie]);
  const clients = [];
  let classrooms;
  try {
    classrooms = await createClassrooms({ http, contracts, teacherCookie: teacher.cookie });
    const students = await joinStudents({ http, contracts, classrooms });
    students.forEach(({ cookie }) => cookies.add(cookie));

    const tracker = new LoadConnectionTracker();
    const normalCommandIds = new Set();
    const normalEvents = new Map();
    const outboxLag = new Map();
    const onEvent = (event) => {
      if (!normalCommandIds.has(event.causationId)) return;
      if (!normalEvents.has(event.causationId)) normalEvents.set(event.causationId, event);
      if (!outboxLag.has(event.causationId)) {
        const ingest = Date.parse(event.ingestTime);
        if (Number.isFinite(ingest)) outboxLag.set(event.causationId, Math.max(0, Date.now() - ingest));
      }
    };

    for (const room of classrooms) {
      const client = new PilotWebSocketClient({
        roomId: room.roomId,
        cookie: teacher.cookie,
        clientId: deterministicUuid(`${identity.runId}:teacher:${room.roomIndex}`),
        contracts,
        WebSocketImpl,
        tracker,
        ca,
        onEvent,
      });
      room.teacherClient = client;
      clients.push(client);
    }
    for (let studentIndex = 0; studentIndex < students.length; studentIndex += 1) {
      const student = students[studentIndex];
      const client = new PilotWebSocketClient({
        roomId: student.roomId,
        cookie: student.cookie,
        clientId: deterministicUuid(`${identity.runId}:student:${studentIndex}`),
        contracts,
        WebSocketImpl,
        tracker,
        ca,
        onEvent,
      });
      student.client = client;
      clients.push(client);
    }
    if (clients.length !== PILOT_FIXTURE.concurrentClients) fail("PILOT_LOAD_CLIENT_COUNT_INVALID");
    await Promise.all(clients.map((client) => client.connect(0)));
    if (tracker.active !== 50 || tracker.maximum !== 50) fail("PILOT_LOAD_CONCURRENCY_FAILED");

    await Promise.all(classrooms.map((room) => room.teacherClient.sendCommand(roomCommand({
      runId: identity.runId,
      roomId: room.roomId,
      type: "room.open",
      suffix: room.roomIndex,
    }))));

    const textAckMs = [];
    const lastNormalSeq = new Map();
    const projectionStartedAt = new Map();
    const indexedStudents = students.map((student, studentIndex) => ({ student, studentIndex }));
    const roomWork = classrooms.map((room) => {
      const roomStudents = indexedStudents.filter(({ student }) => student.roomIndex === room.roomIndex);
      if (roomStudents.length !== PILOT_FIXTURE.studentsPerRoom) {
        fail("PILOT_LOAD_CLIENT_COUNT_INVALID");
      }
      const messagesComplete = Promise.all(roomStudents.map(async ({ student, studentIndex }) => {
        for (let round = 0; round < PILOT_FIXTURE.messageRounds; round += 1) {
          await sleep(deterministicJitterSeconds(studentIndex, round) * 1_000);
          const command = roomCommand({
            runId: identity.runId,
            roomId: student.roomId,
            type: "message.add",
            suffix: `${studentIndex}:${round}`,
            payload: {
              text: `合成觀察 ${student.roomIndex + 1}-${student.seatIndex + 1}-${round + 1}：植物需要陽光，消費者依靠植物取得能量。`,
              mentions: [],
            },
          });
          normalCommandIds.add(command.commandId);
          projectionStartedAt.set(
            student.roomId,
            Math.max(projectionStartedAt.get(student.roomId) ?? 0, performance.now()),
          );
          const acknowledged = await student.client.sendCommand(command);
          textAckMs.push(acknowledged.latencyMs);
          lastNormalSeq.set(
            student.roomId,
            Math.max(lastNormalSeq.get(student.roomId) ?? 0, acknowledged.roomSeq),
          );
        }
      }));
      const projectionWork = messagesComplete.then(() => {
        const targetSeq = lastNormalSeq.get(room.roomId);
        const startedAt = projectionStartedAt.get(room.roomId);
        if (!Number.isSafeInteger(targetSeq) || targetSeq < 1
          || !Number.isFinite(startedAt) || startedAt < 0) {
          fail("PILOT_LOAD_PROJECTION_FAILED");
        }
        return Promise.all([
          pollProjection({
            http, contracts, roomId: room.roomId, cookie: teacher.cookie,
            projectionKey: "echo.teacher_shadow", targetSeq, startedAt,
          }),
          pollProjection({
            http, contracts, roomId: room.roomId, cookie: teacher.cookie,
            projectionKey: "trace.teacher_bundle", targetSeq, startedAt,
          }),
        ]);
      });
      return { messagesComplete, projectionWork };
    });
    await Promise.all(roomWork.map(({ messagesComplete }) => messagesComplete));
    if (textAckMs.length !== NORMAL_COMMANDS || normalCommandIds.size !== NORMAL_COMMANDS) {
      fail("PILOT_LOAD_COMMAND_COUNT_INVALID");
    }
    const projections = (await Promise.all(
      roomWork.map(({ projectionWork }) => projectionWork),
    )).flat();
    await waitUntil(() => outboxLag.size === NORMAL_COMMANDS && normalEvents.size === NORMAL_COMMANDS, {
      code: "PILOT_LOAD_OUTBOX_TIMEOUT",
    });

    const replayMs = await Promise.all(clients.map((client) => client.reconnect()));
    if (tracker.active !== 50 || tracker.maximum !== 50 || replayMs.length !== 50) {
      fail("PILOT_LOAD_RECONNECT_FAILED");
    }

    const firstStudent = students[0];
    const firstEvent = [...normalEvents.values()].find(({ roomId }) => roomId === firstStudent.roomId);
    if (!firstEvent?.eventId) fail("PILOT_LOAD_EVENT_MISSING");
    const media = await http.send({
      method: "POST",
      path: contracts.routes.media.upload(firstStudent.roomId),
      cookie: firstStudent.cookie,
      body: {},
    });
    const mediaCode = assertProviderDisabled("media", media.status, media.body);
    const agent = await http.send({
      method: "POST",
      path: contracts.routes.agent.request(firstStudent.roomId),
      cookie: teacher.cookie,
      body: { triggerEventId: firstEvent.eventId },
    });
    const agentCode = assertProviderDisabled("agent", agent.status, agent.body);

    const slowClient = classrooms[0].teacherClient;
    const backpressureObserved = slowClient.waitForBackpressure(45_000).catch(() => null);
    slowClient.pauseInbound();
    const backpressureText = "合成負載".repeat(850);
    const senders = students.filter(({ roomIndex }) => roomIndex === 0);
    for (let offset = 0; offset < BACKPRESSURE_COMMANDS; offset += 16) {
      await Promise.all(Array.from({ length: Math.min(16, BACKPRESSURE_COMMANDS - offset) }, (_, index) => {
        const sequence = offset + index;
        const sender = senders[sequence % senders.length];
        return sender.client.sendCommand(roomCommand({
          runId: identity.runId,
          roomId: sender.roomId,
          type: "message.add",
          suffix: `backpressure:${sequence}`,
          payload: { text: backpressureText, mentions: [] },
        }));
      }));
    }
    slowClient.resumeInbound();
    if (!await backpressureObserved) fail("PILOT_LOAD_BACKPRESSURE_NOT_OBSERVED");

    await Promise.all(classrooms.map(async (room) => {
      const response = assertStatus(await http.send({
        method: "POST",
        path: `/v1/rooms/${encodeURIComponent(room.roomId)}/commands`,
        cookie: teacher.cookie,
        body: roomCommand({
          runId: identity.runId,
          roomId: room.roomId,
          type: "room.close",
          suffix: room.roomIndex,
        }),
      }), 200, "PILOT_LOAD_ROOM_CLOSE_FAILED");
      if (!Number.isSafeInteger(response.body?.roomSeq) || !Number.isSafeInteger(response.body?.revision)) {
        fail("PILOT_LOAD_ROOM_CLOSE_FAILED");
      }
    }));

    const eventPages = await Promise.all(classrooms.map((room) => getAllEvents({
      http, contracts, roomId: room.roomId, cookie: teacher.cookie,
    })));
    let roomSeqGaps = 0;
    const committedByCommand = new Map();
    for (const events of eventPages) {
      for (let index = 0; index < events.length; index += 1) {
        if (events[index].roomSeq !== index + 1) roomSeqGaps += 1;
        if (normalCommandIds.has(events[index].causationId)) {
          committedByCommand.set(
            events[index].causationId,
            (committedByCommand.get(events[index].causationId) ?? 0) + 1,
          );
        }
      }
    }
    const committedEventLoss = [...normalCommandIds].filter((id) => !committedByCommand.has(id)).length;
    const duplicateCommittedEvents = [...committedByCommand.values()]
      .reduce((sum, count) => sum + Math.max(0, count - 1), 0);
    const projectionNodes = projections.reduce((sum, value) => sum + value.nodes, 0);
    const projectionEdges = projections.reduce((sum, value) => sum + value.edges, 0);
    const report = buildPilotReport({
      sourceSha: sha,
      maxConcurrentClients: tracker.maximum,
      reconnects: replayMs.length,
      commandsSent: NORMAL_COMMANDS,
      committedEvents: eventPages.reduce((sum, events) => sum + events.length, 0),
      committedEventLoss,
      duplicateCommittedEvents,
      roomSeqGaps,
      providerChecks: { media: mediaCode, agent: agentCode },
      textAckMs: summarizeMilliseconds(textAckMs),
      outboxLagMs: summarizeMilliseconds([...outboxLag.values()]),
      deterministicProjectionLagMs: summarizeMilliseconds(projections.map(({ lagMs }) => lagMs)),
      replayMs: summarizeMilliseconds(replayMs),
      projectionNodes,
      projectionEdges,
      errorRate: 0,
      backpressure: {
        snapshotRequired: slowClient.snapshotRequired,
        controlledCloses: slowClient.controlledCloses,
      },
      environment: {
        node: process.version,
        platform,
        arch,
        cpuCount: cpus().length,
        postgresImage: POSTGRES_IMAGE,
        mailpitImage: MAILPIT_IMAGE,
      },
    });
    return validatePilotReport(report);
  } finally {
    const closed = await Promise.allSettled(clients.map((client) => client.close()));
    const revocations = await Promise.allSettled([...cookies].map((cookie) => http.send({
      method: "DELETE", path: contracts.routes.auth.session(), cookie,
    })));
    if (closed.some((result) => result.status === "rejected")
      || revocations.some((result) => result.status === "rejected"
      || result.value.status !== 204)) fail("PILOT_LOAD_SESSION_CLEANUP_FAILED");
  }
}

try {
  const report = await run();
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  process.stderr.write(`${stableCode(error)}\n`);
  process.exitCode = 1;
}
