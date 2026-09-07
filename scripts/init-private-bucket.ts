#!/usr/bin/env -S pnpm tsx
/**
 * Create the media bucket if it is absent and prove it is private.
 *
 * Idempotent. It never relaxes a policy: if the bucket already carries any
 * anonymous grant it fails rather than "fixing" it, because silently making a
 * store public-then-private again is exactly the window that leaks media.
 */
import { env, exit, stderr, stdout } from "node:process";

import {
  authorizationHeaders,
  EMPTY_PAYLOAD_SHA256,
  type S3Credentials,
} from "../apps/server/src/modules/media/s3-signature.js";

const endpoint = env.LO_STORAGE_ENDPOINT ?? "http://127.0.0.1:59000";
const bucket = env.LO_STORAGE_BUCKET ?? "learning-orbit-media";
const credentials: S3Credentials = {
  accessKeyId: env.LO_STORAGE_ACCESS_KEY_ID ?? "",
  secretAccessKey: env.LO_STORAGE_SECRET_ACCESS_KEY ?? "",
  region: env.LO_STORAGE_REGION ?? "us-east-1",
};

async function call(method: string, path: string, query: Record<string, string> = {}) {
  const headers = authorizationHeaders({
    method,
    endpoint,
    path,
    query,
    payloadSha256: EMPTY_PAYLOAD_SHA256,
    credentials,
    now: new Date(),
  });
  const search = new URLSearchParams(query).toString();
  return fetch(`${endpoint}${path}${search ? `?${search}` : ""}`, { method, headers });
}

async function main(): Promise<void> {
  if (!credentials.accessKeyId || !credentials.secretAccessKey) {
    stderr.write("LO_STORAGE_ACCESS_KEY_ID and LO_STORAGE_SECRET_ACCESS_KEY are required\n");
    exit(2);
  }

  const head = await call("HEAD", `/${bucket}`);
  if (head.status === 404) {
    const created = await call("PUT", `/${bucket}`);
    if (!created.ok) {
      stderr.write(`bucket create failed: ${created.status}\n`);
      exit(1);
    }
    stdout.write(`created private bucket ${bucket}\n`);
  } else if (!head.ok) {
    stderr.write(`bucket probe failed: ${head.status}\n`);
    exit(1);
  } else {
    stdout.write(`bucket ${bucket} already exists\n`);
  }

  // A bucket with no policy is private. Any policy at all is reported rather
  // than rewritten: deciding an existing grant is safe is not this script's call.
  const policy = await call("GET", `/${bucket}`, { policy: "" });
  if (policy.status === 404) {
    stdout.write("policy: none (private)\n");
  } else if (policy.ok) {
    const body = await policy.text();
    if (/"Principal"\s*:\s*(\{\s*"AWS"\s*:\s*)?("\*"|\[[^\]]*"\*"[^\]]*\])/.test(body)) {
      stderr.write("bucket carries an anonymous policy; refusing to treat it as private\n");
      exit(1);
    }
    stdout.write("policy: present, no anonymous principal\n");
  } else {
    stderr.write(`policy probe failed: ${policy.status}\n`);
    exit(1);
  }
  stdout.write("private bucket: PASS\n");

}

void main();
