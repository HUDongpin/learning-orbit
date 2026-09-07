/**
 * Deterministic fault injection, and the rule that keeps it out of production.
 *
 * A chaos suite needs to pause the outbox, drop an acknowledgement and skew a
 * clock on demand; guessing at those conditions produces a flaky test that
 * proves nothing. But the same switches in a running classroom are a denial of
 * service with a documented API, so the gate here is deliberately blunt:
 * `LEARNING_ORBIT_TEST_FAULTS=1` enables them, and a production start that
 * sees the variable at all refuses to boot rather than ignoring it.
 *
 * Refusing to boot is the point. A server that quietly dropped the variable
 * would leave an operator believing faults were armed when they were not, or —
 * far worse — believing they were disarmed because nothing complained.
 */

/** Faults a test may arm. Anything outside this set is refused by name. */
export const FAULT_NAMES = Object.freeze([
  "outbox.paused",
  "websocket.drop_next_ack",
  "worker.crash_after_claim",
  "client.clock_skew_ms",
] as const);

export type FaultName = (typeof FAULT_NAMES)[number];

export class FaultControlError extends Error {
  constructor(readonly code: string) { super(code); }
}

/**
 * Decide whether fault controls may exist in this process.
 *
 * Called before Fastify is constructed, so a misconfigured production process
 * fails at startup rather than at the first injected fault.
 */
export function faultControlsEnabled(env: NodeJS.ProcessEnv, nodeEnv = env.NODE_ENV): boolean {
  const requested = env.LEARNING_ORBIT_TEST_FAULTS;
  if (requested === undefined) return false;
  if (nodeEnv === "production") throw new FaultControlError("TEST_FAULTS_FORBIDDEN_IN_PRODUCTION");
  if (requested !== "1") throw new FaultControlError("TEST_FAULTS_INVALID");
  return true;
}

/**
 * In-process fault state.
 *
 * Every fault is one-shot or explicitly cleared, and `reset` returns the
 * process to normal, so a scenario that fails part-way cannot leave the next
 * one running against a half-broken server.
 */
export class FaultController {
  #outboxPaused = false;
  #dropNextAck = false;
  #crashAfterClaim = false;
  #clockSkewMs = 0;

  get outboxPaused(): boolean { return this.#outboxPaused; }
  get crashAfterClaim(): boolean { return this.#crashAfterClaim; }
  get clockSkewMs(): number { return this.#clockSkewMs; }

  /**
   * Report whether this acknowledgement should be dropped, and disarm.
   *
   * One-shot rather than a mode: a test that armed it and then took an
   * unexpected path would otherwise silently break every later send.
   */
  takeAckDrop(): boolean {
    const drop = this.#dropNextAck;
    this.#dropNextAck = false;
    return drop;
  }

  arm(name: string, value: unknown): void {
    if (!FAULT_NAMES.includes(name as FaultName)) throw new FaultControlError("FAULT_UNKNOWN");
    switch (name as FaultName) {
      case "outbox.paused":
        this.#outboxPaused = assertBoolean(value);
        return;
      case "websocket.drop_next_ack":
        this.#dropNextAck = assertBoolean(value);
        return;
      case "worker.crash_after_claim":
        this.#crashAfterClaim = assertBoolean(value);
        return;
      case "client.clock_skew_ms":
        this.#clockSkewMs = assertSkew(value);
    }
  }

  snapshot(): Readonly<Record<FaultName, boolean | number>> {
    return Object.freeze({
      "outbox.paused": this.#outboxPaused,
      "websocket.drop_next_ack": this.#dropNextAck,
      "worker.crash_after_claim": this.#crashAfterClaim,
      "client.clock_skew_ms": this.#clockSkewMs,
    });
  }

  reset(): void {
    this.#outboxPaused = false;
    this.#dropNextAck = false;
    this.#crashAfterClaim = false;
    this.#clockSkewMs = 0;
  }
}

function assertBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new FaultControlError("FAULT_VALUE_INVALID");
  return value;
}

/**
 * A skew is bounded to one day either way. An unbounded skew would let a test
 * push a room's clock past any expiry the system has, which would prove the
 * expiry can be bypassed rather than that it works.
 */
function assertSkew(value: unknown): number {
  const day = 24 * 60 * 60 * 1000;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Math.abs(value) > day) {
    throw new FaultControlError("FAULT_VALUE_INVALID");
  }
  return value;
}
