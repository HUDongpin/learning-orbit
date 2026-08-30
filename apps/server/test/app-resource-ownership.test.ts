import { describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

import { buildApp } from "../src/app.js";
import type { MailTransport } from "../src/modules/auth/mailer.js";

const config = { allowedOrigins: ["https://app.learning-orbit.test"], publicBaseOrigin: "https://app.learning-orbit.test" };

describe("app resource ownership", () => {
  it("does not close injected resources and closes resources it creates", async () => {
    const external = new Pool({ connectionString: "postgres://unused.invalid/external" });
    const externalEnd = vi.spyOn(external, "end").mockResolvedValue(undefined);
    const externalApp = await buildApp({ pool: external, config });
    await externalApp.close();
    expect(externalEnd).not.toHaveBeenCalled();

    const created = new Pool({ connectionString: "postgres://unused.invalid/created" });
    const createdEnd = vi.spyOn(created, "end").mockResolvedValue(undefined);
    const internalApp = await buildApp({ databaseUrl: "postgres://test", createPool: () => created, config });
    await internalApp.close();
    expect(createdEnd).toHaveBeenCalledTimes(1);

    const externalMailClose = vi.fn();
    const externalMail: MailTransport = { sendMail: vi.fn(async () => undefined), close: externalMailClose };
    const externalMailApp = await buildApp({ config, mailTransport: externalMail });
    await externalMailApp.close();
    expect(externalMailClose).not.toHaveBeenCalled();

    const internalMailClose = vi.fn();
    const internalMail: MailTransport = { sendMail: vi.fn(async () => undefined), close: internalMailClose };
    const ownedMailApp = await buildApp({
      config: { ...config, smtpHost: "127.0.0.1", smtpPort: 1025, smtpFrom: "no-reply@learning-orbit.test" },
      createSmtpMailer: () => ({ sender: async () => undefined, transport: internalMail }),
    });
    await ownedMailApp.close();
    expect(internalMailClose).toHaveBeenCalledTimes(1);

    externalEnd.mockRestore();
    createdEnd.mockRestore();
    await external.end();
    await created.end();
  });
});
