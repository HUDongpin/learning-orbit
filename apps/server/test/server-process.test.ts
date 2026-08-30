import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { superviseServerApp } from "../src/server-process.js";

class FakeHost extends EventEmitter {
  exitCode: number | undefined;
}

describe("Fastify composition-root shutdown", () => {
  it("closes already-created resources when the configured port is invalid", async () => {
    const host = new FakeHost();
    const app = {
      listen: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    expect(await superviseServerApp({ app, host, port: 0 })).toBe(1);
    expect(app.listen).not.toHaveBeenCalled();
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(host.listenerCount("SIGTERM")).toBe(0);
    expect(host.listenerCount("SIGINT")).toBe(0);
  });

  it("normalizes a synchronous close throw on an invalid port", async () => {
    const host = new FakeHost();
    const app = {
      listen: vi.fn(async () => undefined),
      close: vi.fn(() => { throw new Error("sensitive close detail"); }),
    };
    await expect(superviseServerApp({ app, host, port: 70_000 })).resolves.toBe(1);
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it("closes exactly once on SIGTERM and removes both signal listeners", async () => {
    const host = new FakeHost();
    let releaseListen!: () => void;
    const app = {
      listen: vi.fn(() => new Promise<void>((resolve) => { releaseListen = resolve; })),
      close: vi.fn(async () => undefined),
    };
    const result = superviseServerApp({ app, host, port: 3001 });
    releaseListen();
    await Promise.resolve();
    host.emit("SIGTERM");
    host.emit("SIGTERM");
    expect(await result).toBe(0);
    expect(app.listen).toHaveBeenCalledWith({ port: 3001, host: "127.0.0.1" });
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(host.listenerCount("SIGTERM")).toBe(0);
    expect(host.listenerCount("SIGINT")).toBe(0);
  });

  it("uses the same close path for SIGINT", async () => {
    const host = new FakeHost();
    const app = {
      listen: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const result = superviseServerApp({ app, host, port: 3001 });
    await Promise.resolve();
    host.emit("SIGINT");
    expect(await result).toBe(0);
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it("closes once and fails when listen rejects", async () => {
    const host = new FakeHost();
    const app = {
      listen: vi.fn(async () => { throw new Error("sensitive listen detail"); }),
      close: vi.fn(async () => undefined),
    };
    expect(await superviseServerApp({ app, host, port: 3001 })).toBe(1);
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(host.listenerCount("SIGTERM")).toBe(0);
    expect(host.listenerCount("SIGINT")).toBe(0);
  });

  it("also closes and cleans listeners when listen throws synchronously", async () => {
    const host = new FakeHost();
    const app = {
      listen: vi.fn(() => { throw new Error("sensitive synchronous detail"); }),
      close: vi.fn(async () => undefined),
    };
    expect(await superviseServerApp({ app, host, port: 3001 })).toBe(1);
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(host.listenerCount("SIGTERM")).toBe(0);
    expect(host.listenerCount("SIGINT")).toBe(0);
  });

  it("makes close failure fail the process without retrying", async () => {
    const host = new FakeHost();
    const app = {
      listen: vi.fn(async () => undefined),
      close: vi.fn(async () => { throw new Error("sensitive close detail"); }),
    };
    const result = superviseServerApp({ app, host, port: 3001 });
    await Promise.resolve();
    host.emit("SIGTERM");
    expect(await result).toBe(1);
    expect(app.close).toHaveBeenCalledTimes(1);
  });
});
