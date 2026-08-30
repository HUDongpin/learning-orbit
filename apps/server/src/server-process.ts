type SignalName = "SIGINT" | "SIGTERM";

export interface ServerProcessHost {
  on(event: SignalName, listener: () => void): unknown;
  off(event: SignalName, listener: () => void): unknown;
}

export interface ServerAppProcess {
  listen(options: Readonly<{ port: number; host: string }>): Promise<unknown>;
  close(): Promise<unknown>;
}

export function superviseServerApp(options: Readonly<{
  app: ServerAppProcess;
  host?: ServerProcessHost;
  port: number;
}>): Promise<number> {
  const { app, port } = options;
  const host = options.host ?? process;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return Promise.resolve().then(() => app.close()).then(() => 1, () => 1);
  }

  return new Promise<number>((resolve) => {
    let settled = false;
    let closing = false;

    const cleanup = () => {
      host.off("SIGINT", onSignal);
      host.off("SIGTERM", onSignal);
    };
    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(exitCode);
    };
    const closeAndSettle = async (requestedExitCode: number) => {
      if (closing || settled) return;
      closing = true;
      let exitCode = requestedExitCode;
      try {
        await app.close();
      } catch {
        exitCode = 1;
      }
      settle(exitCode);
    };
    function onSignal() {
      void closeAndSettle(0);
    }

    host.on("SIGINT", onSignal);
    host.on("SIGTERM", onSignal);
    let listenResult: Promise<unknown>;
    try {
      listenResult = app.listen({ port, host: "127.0.0.1" });
    } catch {
      void closeAndSettle(1);
      return;
    }
    void Promise.resolve(listenResult).catch(() => closeAndSettle(1));
  });
}
