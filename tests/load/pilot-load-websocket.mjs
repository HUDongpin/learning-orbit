import { performance } from "node:perf_hooks";

import { buildLocalWebSocketUrl } from "./pilot-load-contract.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COOKIE = /^lo_session=[A-Za-z0-9_-]{20,512}$/;
const CONNECT_TIMEOUT_MS = 10_000;

function fail(code) {
  throw new Error(code);
}

export class LoadConnectionTracker {
  #activeIds = new Set();
  active = 0;
  maximum = 0;
  opens = 0;
  closes = 0;

  open(id) {
    if (typeof id !== "string" || this.#activeIds.has(id)) fail("PILOT_LOAD_CONNECTION_TRACKER_INVALID");
    this.#activeIds.add(id);
    this.active += 1;
    this.opens += 1;
    this.maximum = Math.max(this.maximum, this.active);
  }

  close(id) {
    if (!this.#activeIds.delete(id)) return;
    this.active -= 1;
    this.closes += 1;
    if (this.active < 0) fail("PILOT_LOAD_CONNECTION_TRACKER_INVALID");
  }
}

function boundedFrame(data, isBinary) {
  if (isBinary) fail("PILOT_LOAD_WEBSOCKET_FRAME_INVALID");
  const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) fail("PILOT_LOAD_WEBSOCKET_FRAME_INVALID");
  try { return JSON.parse(text); } catch { fail("PILOT_LOAD_WEBSOCKET_FRAME_INVALID"); }
}

export class PilotWebSocketClient {
  #socket;
  #contracts;
  #WebSocketImpl;
  #tracker;
  #ca;
  #clock;
  #connectPromise;
  #connectResolve;
  #connectReject;
  #welcome = false;
  #resumeComplete = false;
  #opened = false;
  #commandWaiters = new Map();
  #backpressureWaiter;
  #eventObserver;

  lastSeenSeq = 0;
  snapshotRequired = 0;
  controlledCloses = 0;

  constructor({
    roomId,
    cookie,
    clientId,
    contracts,
    WebSocketImpl,
    tracker,
    ca,
    clock = () => performance.now(),
    onEvent = () => undefined,
  }) {
    if (!UUID.test(roomId ?? "") || !UUID.test(clientId ?? "") || !COOKIE.test(cookie ?? "")
      || !contracts?.routes?.rooms?.websocket || !contracts?.realtimeContract?.encodeClientFrame
      || !contracts?.realtimeContract?.parseServerFrame || typeof WebSocketImpl !== "function"
      || !(tracker instanceof LoadConnectionTracker) || !(ca instanceof Uint8Array) || ca.byteLength < 1
      || typeof clock !== "function" || typeof onEvent !== "function") {
      fail("PILOT_LOAD_WEBSOCKET_CONFIG_INVALID");
    }
    this.roomId = roomId;
    this.cookie = cookie;
    this.clientId = clientId;
    this.#contracts = contracts;
    this.#WebSocketImpl = WebSocketImpl;
    this.#tracker = tracker;
    this.#ca = ca;
    this.#clock = clock;
    this.#eventObserver = onEvent;
  }

  async connect(resumeFrom = this.lastSeenSeq) {
    if (!Number.isSafeInteger(resumeFrom) || resumeFrom < 0 || this.#socket) {
      fail("PILOT_LOAD_WEBSOCKET_STATE_INVALID");
    }
    this.#welcome = false;
    this.#resumeComplete = false;
    const route = this.#contracts.routes.rooms.websocket(this.roomId);
    const url = buildLocalWebSocketUrl("https://127.0.0.1:3000", route);
    const socket = new this.#WebSocketImpl(url, {
      origin: "https://127.0.0.1:3000",
      headers: { Cookie: this.cookie },
      ca: this.#ca,
      rejectUnauthorized: true,
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      maxPayload: 1024 * 1024,
    });
    this.#socket = socket;
    let connectTimer;
    this.#connectPromise = new Promise((resolvePromise, reject) => {
      this.#connectResolve = resolvePromise;
      this.#connectReject = reject;
      connectTimer = setTimeout(() => reject(new Error("PILOT_LOAD_WEBSOCKET_CONNECT_TIMEOUT")), CONNECT_TIMEOUT_MS);
      connectTimer.unref?.();
    });
    socket.on("message", (data, isBinary) => this.#receive(data, isBinary));
    socket.once("error", () => this.#terminate("PILOT_LOAD_WEBSOCKET_FAILED"));
    socket.once("close", (code) => this.#closed(code));
    socket.once("open", () => {
      this.#opened = true;
      this.#tracker.open(this.clientId);
      this.#send({ type: "hello", clientId: this.clientId, resumeFrom });
    });
    try { await this.#connectPromise; }
    finally { clearTimeout(connectTimer); }
    return this;
  }

  #send(frame) {
    if (!this.#socket || this.#socket.readyState !== 1) fail("PILOT_LOAD_WEBSOCKET_NOT_OPEN");
    this.#socket.send(this.#contracts.realtimeContract.encodeClientFrame(frame));
  }

  #receive(data, isBinary) {
    let frame;
    try {
      frame = this.#contracts.realtimeContract.parseServerFrame(boundedFrame(data, isBinary));
    } catch {
      this.#terminate("PILOT_LOAD_WEBSOCKET_FRAME_INVALID");
      return;
    }
    if (frame.type === "welcome") this.#welcome = true;
    if (frame.type === "resume_complete") {
      this.#resumeComplete = true;
      this.lastSeenSeq = Math.max(this.lastSeenSeq, frame.throughRoomSeq);
    }
    if (frame.type === "event") {
      this.lastSeenSeq = Math.max(this.lastSeenSeq, frame.event.roomSeq);
      this.#eventObserver(frame.event, this.#clock());
    }
    if (frame.type === "ack") {
      const waiter = this.#commandWaiters.get(frame.commandId);
      if (waiter) {
        this.#commandWaiters.delete(frame.commandId);
        waiter.resolve({
          roomSeq: frame.roomSeq,
          revision: frame.revision,
          latencyMs: Math.max(0, this.#clock() - waiter.startedAt),
        });
      }
    }
    if (frame.type === "reject" && frame.commandId) {
      const waiter = this.#commandWaiters.get(frame.commandId);
      if (waiter) {
        this.#commandWaiters.delete(frame.commandId);
        waiter.reject(new Error("PILOT_LOAD_COMMAND_REJECTED"));
      }
    }
    if (frame.type === "snapshot_required") {
      this.snapshotRequired += 1;
      this.#backpressureWaiter?.resolve("snapshot_required");
      this.#backpressureWaiter = undefined;
    }
    if (this.#welcome && this.#resumeComplete) this.#connectResolve?.(this);
  }

  #terminate(code) {
    this.#connectReject?.(new Error(code));
    for (const waiter of this.#commandWaiters.values()) waiter.reject(new Error(code));
    this.#commandWaiters.clear();
    try { this.#socket?.close(); } catch { /* close handler owns public state */ }
  }

  #closed(code) {
    if (this.#opened) {
      this.#opened = false;
      this.#tracker.close(this.clientId);
    }
    if (code === 1013 || code === 4409) {
      this.controlledCloses += 1;
      this.#backpressureWaiter?.resolve("controlled_close");
      this.#backpressureWaiter = undefined;
    } else if (code !== 1000) {
      this.#backpressureWaiter?.reject(new Error("PILOT_LOAD_WEBSOCKET_UNEXPECTED_CLOSE"));
      this.#backpressureWaiter = undefined;
    }
    this.#socket = undefined;
    this.#connectReject?.(new Error("PILOT_LOAD_WEBSOCKET_CLOSED"));
    for (const waiter of this.#commandWaiters.values()) waiter.reject(new Error("PILOT_LOAD_WEBSOCKET_CLOSED"));
    this.#commandWaiters.clear();
  }

  sendCommand(command) {
    if (!UUID.test(command?.commandId ?? "") || this.#commandWaiters.has(command.commandId)) {
      return Promise.reject(new Error("PILOT_LOAD_COMMAND_INVALID"));
    }
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#commandWaiters.delete(command.commandId);
        reject(new Error("PILOT_LOAD_COMMAND_TIMEOUT"));
      }, CONNECT_TIMEOUT_MS);
      timer.unref?.();
      this.#commandWaiters.set(command.commandId, {
        startedAt: this.#clock(),
        resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try { this.#send({ type: "command", command }); }
      catch (error) {
        clearTimeout(timer);
        this.#commandWaiters.delete(command.commandId);
        reject(error);
      }
    });
  }

  async reconnect() {
    const startedAt = this.#clock();
    const resumeFrom = this.lastSeenSeq;
    await this.close();
    await this.connect(resumeFrom);
    return Math.max(0, this.#clock() - startedAt);
  }

  pauseInbound() {
    if (!this.#socket?._socket || typeof this.#socket._socket.pause !== "function") {
      fail("PILOT_LOAD_SLOW_CLIENT_UNAVAILABLE");
    }
    this.#socket._socket.pause();
  }

  resumeInbound() {
    if (!this.#socket?._socket || typeof this.#socket._socket.resume !== "function") {
      fail("PILOT_LOAD_SLOW_CLIENT_UNAVAILABLE");
    }
    this.#socket._socket.resume();
  }

  waitForBackpressure(timeoutMs = 15_000) {
    if (this.#backpressureWaiter || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new Error("PILOT_LOAD_BACKPRESSURE_STATE_INVALID"));
    }
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#backpressureWaiter = undefined;
        reject(new Error("PILOT_LOAD_BACKPRESSURE_NOT_OBSERVED"));
      }, timeoutMs);
      this.#backpressureWaiter = {
        resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
    });
  }

  close() {
    const socket = this.#socket;
    if (!socket) return Promise.resolve();
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("PILOT_LOAD_WEBSOCKET_CLOSE_TIMEOUT")), CONNECT_TIMEOUT_MS);
      timer.unref?.();
      socket.once("close", () => { clearTimeout(timer); resolvePromise(); });
      try { socket.close(1000, "pilot reconnect"); }
      catch { clearTimeout(timer); reject(new Error("PILOT_LOAD_WEBSOCKET_CLOSE_FAILED")); }
    });
  }
}
