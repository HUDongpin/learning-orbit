import nodemailer from "nodemailer";

import type { SendMagicLink } from "./magic-link-service.js";

export interface MailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
  close(): void | Promise<void>;
}

export function createSmtpMailer(host: string, port: number, from: string): { sender: SendMagicLink; transport: MailTransport } {
  const transport = nodemailer.createTransport({ host, port, secure: false });
  return {
    transport,
    sender: async (email, url) => { await transport.sendMail({ from, to: email, subject: "Learning Orbit sign-in link", text: url }); },
  };
}
