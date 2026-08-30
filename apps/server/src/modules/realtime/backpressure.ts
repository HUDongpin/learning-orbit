/** Bounded WebSocket send-buffer policy used by the pilot server. */
export type BackpressureState = "ok" | "warn" | "close";

export type BackpressureThresholds = Readonly<{
  warn: number;
  close: number;
}>;

const DEFAULTS: BackpressureThresholds = Object.freeze({ warn: 256_000, close: 1_000_000 });

export function enforceBackpressure(
  socket: Pick<WebSocket, "bufferedAmount" | "close">,
  thresholds: BackpressureThresholds = DEFAULTS,
): BackpressureState {
  if (!Number.isSafeInteger(socket.bufferedAmount) || socket.bufferedAmount < 0) return "close";
  if (!Number.isSafeInteger(thresholds.warn) || !Number.isSafeInteger(thresholds.close)
    || thresholds.warn < 0 || thresholds.close <= thresholds.warn) return "close";
  if (socket.bufferedAmount >= thresholds.close) {
    socket.close(1013, "snapshot required");
    return "close";
  }
  return socket.bufferedAmount >= thresholds.warn ? "warn" : "ok";
}

