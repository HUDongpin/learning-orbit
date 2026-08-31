import { request as httpsRequest } from "node:https";
import { X509Certificate } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

const PUBLIC_ORIGIN = "https://127.0.0.1:3000";
const SESSION = /^lo_session=([A-Za-z0-9_-]{20,512})$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function fail(code) {
  throw new Error(code);
}

function plain(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function derivePilotRunIdentity(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    fail("PILOT_LOAD_DATABASE_URL_INVALID");
  }
  const database = parsed.pathname.slice(1);
  const match = /^lo_pilot_([0-9a-f]{16})_test$/.exec(database);
  if (parsed.protocol !== "postgres:" || parsed.hostname !== "127.0.0.1"
    || parsed.port !== "55432" || parsed.username !== "learning_orbit"
    || parsed.password.length < 1 || parsed.password.length > 256
    || parsed.search !== "" || parsed.hash !== "" || !match) {
    fail("PILOT_LOAD_DATABASE_URL_INVALID");
  }
  return Object.freeze({
    runId: match[1],
    teacherAddress: `pilot-${match[1]}@example.invalid`,
  });
}

export function extractOpaqueSessionCookie(setCookieHeaders) {
  if (!Array.isArray(setCookieHeaders) || setCookieHeaders.length !== 1
    || typeof setCookieHeaders[0] !== "string" || setCookieHeaders[0].includes("\u0000")) {
    fail("PILOT_LOAD_SESSION_COOKIE_INVALID");
  }
  const parts = setCookieHeaders[0].split(";").map((part) => part.trim());
  const pair = parts.shift();
  if (!pair || !SESSION.test(pair)) fail("PILOT_LOAD_SESSION_COOKIE_INVALID");
  const attributes = new Map();
  for (const part of parts) {
    const separator = part.indexOf("=");
    const name = (separator < 0 ? part : part.slice(0, separator)).toLowerCase();
    const value = separator < 0 ? true : part.slice(separator + 1);
    if (!name || attributes.has(name)) fail("PILOT_LOAD_SESSION_COOKIE_INVALID");
    attributes.set(name, value);
  }
  if (attributes.get("path") !== "/" || attributes.get("httponly") !== true
    || attributes.get("secure") !== true
    || String(attributes.get("samesite")).toLowerCase() !== "lax"
    || attributes.get("max-age") !== "28800" || attributes.has("domain")) {
    fail("PILOT_LOAD_SESSION_COOKIE_INVALID");
  }
  return pair;
}

export function assertProviderDisabled(kind, status, body) {
  const code = kind === "media" ? "MEDIA_SERVICE_UNAVAILABLE"
    : kind === "agent" ? "AGENT_SERVICE_UNAVAILABLE" : undefined;
  if (!code || status !== 503 || !plain(body)
    || Object.keys(body).length !== 1 || body.code !== code) {
    fail("PILOT_LOAD_PROVIDER_BOUNDARY_FAILED");
  }
  return code;
}

export async function loadPilotCaFile(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\u0000")) {
    fail("PILOT_LOAD_CA_FILE_INVALID");
  }
  let info;
  let bytes;
  try {
    info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600
      || info.size < 1 || info.size > 64 * 1024
      || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      fail("PILOT_LOAD_CA_FILE_INVALID");
    }
    bytes = await readFile(path);
  } catch (error) {
    if (error instanceof Error && error.message === "PILOT_LOAD_CA_FILE_INVALID") throw error;
    fail("PILOT_LOAD_CA_FILE_INVALID");
  }
  try {
    const certificate = new X509Certificate(bytes);
    const remaining = new Date(certificate.validTo).getTime() - Date.now();
    if (certificate.checkIP("127.0.0.1") !== "127.0.0.1"
      || certificate.checkHost("localhost") !== "localhost"
      || !Number.isFinite(remaining) || remaining <= 0 || remaining > 25 * 60 * 60 * 1_000) {
      fail("PILOT_LOAD_CA_FILE_INVALID");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "PILOT_LOAD_CA_FILE_INVALID") throw error;
    fail("PILOT_LOAD_CA_FILE_INVALID");
  }
  return bytes;
}

function assertPath(path) {
  if (typeof path !== "string" || !path.startsWith("/v1/") || path.includes("\u0000")) {
    fail("PILOT_LOAD_HTTP_PATH_INVALID");
  }
  let parsed;
  try {
    parsed = new URL(path, PUBLIC_ORIGIN);
  } catch {
    fail("PILOT_LOAD_HTTP_PATH_INVALID");
  }
  if (parsed.origin !== PUBLIC_ORIGIN || parsed.username || parsed.password || parsed.hash) {
    fail("PILOT_LOAD_HTTP_PATH_INVALID");
  }
  return `${parsed.pathname}${parsed.search}`;
}

function boundedJson(value) {
  const text = JSON.stringify(value);
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 64 * 1024
    || text.includes("\u0000")) fail("PILOT_LOAD_HTTP_BODY_INVALID");
  return text;
}

export class LocalHttpsClient {
  #request;
  #ca;

  constructor({ origin = PUBLIC_ORIGIN, request = httpsRequest, ca } = {}) {
    if (origin !== PUBLIC_ORIGIN || typeof request !== "function") {
      fail("PILOT_LOAD_ORIGIN_INVALID");
    }
    if (!(ca instanceof Uint8Array) || ca.byteLength < 1 || ca.byteLength > 64 * 1024) {
      fail("PILOT_LOAD_CA_REQUIRED");
    }
    this.#request = request;
    this.#ca = ca;
  }

  async send({ method, path, cookie, body }) {
    if (!new Set(["GET", "POST", "PUT", "DELETE"]).has(method)) {
      fail("PILOT_LOAD_HTTP_METHOD_INVALID");
    }
    const requestPath = assertPath(path);
    if (cookie !== undefined && (typeof cookie !== "string" || !SESSION.test(cookie))) {
      fail("PILOT_LOAD_SESSION_COOKIE_INVALID");
    }
    const payload = body === undefined ? undefined : boundedJson(body);
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      const settle = (callback) => {
        if (settled) return;
        settled = true;
        callback();
      };
      const request = this.#request({
        protocol: "https:",
        hostname: "127.0.0.1",
        port: 3000,
        method,
        path: requestPath,
        rejectUnauthorized: true,
        ca: this.#ca,
        timeout: 10_000,
        headers: {
          accept: "application/json,text/plain",
          origin: PUBLIC_ORIGIN,
          ...(cookie ? { cookie } : {}),
          ...(payload === undefined ? {} : {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload, "utf8"),
          }),
        },
      }, (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("PILOT_LOAD_HTTP_RESPONSE_TOO_LARGE"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", () => settle(() => reject(new Error("PILOT_LOAD_HTTP_FAILED"))));
        response.once("end", () => settle(() => {
          const text = Buffer.concat(chunks).toString("utf8");
          const contentType = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
          let parsedBody = null;
          if (text.length > 0) {
            if (contentType === "application/json") {
              try { parsedBody = JSON.parse(text); } catch { return reject(new Error("PILOT_LOAD_HTTP_RESPONSE_INVALID")); }
            } else {
              parsedBody = text;
            }
          }
          resolvePromise(Object.freeze({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: parsedBody,
          }));
        }));
      });
      request.once("timeout", () => request.destroy(new Error("PILOT_LOAD_HTTP_TIMEOUT")));
      request.once("error", () => settle(() => reject(new Error("PILOT_LOAD_HTTP_FAILED"))));
      if (payload !== undefined) request.write(payload);
      request.end();
    });
  }
}
