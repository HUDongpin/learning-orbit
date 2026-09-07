/**
 * The worker image carries the server's SQL, and carries all of it.
 *
 * `pnpm verify:worker-sql` compares the bytes in a built image against the
 * sources, which catches a file that changed. It cannot catch the other
 * direction: the worker starting to read a *sixth* canonical file that the
 * Dockerfile never copies. That failure appears at the first claim in
 * production, as an ENOENT from a module import.
 *
 * So the set is derived here from the worker's own Python source rather than
 * from a list someone maintains, and compared to what the Dockerfile copies
 * and what the verifier checks. All three have to agree.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);

async function read(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

/** Every canonical SQL file the worker's own modules read at import time. */
async function sqlFilesTheWorkerReads(): Promise<string[]> {
  const modules = ["jobs.py", "room_lock.py"];
  const names = new Set<string>();
  for (const module of modules) {
    const source = await read(`services/worker/src/learning_orbit_worker/${module}`);
    for (const [, name] of source.matchAll(/"([a-z_]+\.sql)"/g)) names.add(name);
  }
  return [...names].sort();
}

describe("worker container SQL contract", () => {
  it("copies exactly the canonical files the worker reads, and no directory", async () => {
    const dockerfile = await read("infra/docker/worker.Dockerfile");
    const expected = await sqlFilesTheWorkerReads();
    expect(expected.length).toBeGreaterThan(0);

    const copied = [...dockerfile.matchAll(/apps\/server\/src\/db\/sql\/([a-z_]+\.sql)/g)]
      .map(([, name]) => name)
      .sort();
    expect(copied).toEqual(expected);

    // Copying the directory would let a new server-owned statement reach the
    // worker image without anyone deciding that it should.
    expect(dockerfile).not.toMatch(/COPY\s+apps\/server\/src\/db\/sql\s/);
    expect(dockerfile).not.toMatch(/COPY\s+apps\/server\/src\/db\/sql\/\*/);
  });

  it("checks the same set in the verifier", async () => {
    const verifier = await read("scripts/verify-worker-runtime-sql.mjs");
    const expected = await sqlFilesTheWorkerReads();
    const checked = [...verifier.matchAll(/"([a-z_]+\.sql)"/g)].map(([, name]) => name).sort();
    expect([...new Set(checked)]).toEqual(expected);
  });

  it("pins the base image by digest, never by tag", async () => {
    const dockerfile = await read("infra/docker/worker.Dockerfile");
    const lock = JSON.parse(await read("infra/images.lock.json"));
    const digest = lock.images["python-worker-base"].digest;
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(dockerfile).toContain(`FROM python@${digest}`);
    // A bare tag is a name for whatever was pushed last.
    expect(dockerfile).not.toMatch(/^FROM python:[^@\s]+\s*$/m);
  });

  it("pins ffmpeg by digest instead of resolving it from an archive", async () => {
    const dockerfile = await read("infra/docker/worker.Dockerfile");
    const lock = JSON.parse(await read("infra/images.lock.json"));
    const digest = lock.images.ffmpeg.digest;
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(dockerfile).toContain(`@${digest} AS ffmpeg`);
    expect(dockerfile).toContain("COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg");
    // The worker's only component that decodes attacker-supplied media must
    // not be whatever an archive serves on the day of the build, and a package
    // manager in this image would be exactly that. Comments are excluded: the
    // Dockerfile explains why it does not use one, and that prose is not an
    // instruction.
    const instructions = dockerfile.split("\n").filter((line) => !line.trimStart().startsWith("#"));
    expect(instructions.join("\n")).not.toMatch(/apt-get|apk add|yum install/u);
  });

  it("installs from the hashed lock and lets a missing hash fail the build", async () => {
    const dockerfile = await read("infra/docker/worker.Dockerfile");
    expect(dockerfile).toContain("--require-hashes");
    expect(dockerfile).toContain("services/worker/requirements.lock");
  });

  it("runs as a non-root user over read-only application files", async () => {
    const dockerfile = await read("infra/docker/worker.Dockerfile");
    expect(dockerfile).toMatch(/USER\s+10001:10001/);
    expect(dockerfile).toMatch(/chmod -R a-w/);
    // Root would make the byte check meaningless: the image can hold a file
    // the process that needs it cannot open.
    expect(dockerfile.lastIndexOf("USER 10001:10001")).toBeGreaterThan(dockerfile.indexOf("COPY services/worker/src"));
  });

  it("records the commit it was built from, so a stale image is detectable", async () => {
    const dockerfile = await read("infra/docker/worker.Dockerfile");
    const verifier = await read("scripts/verify-worker-runtime-sql.mjs");
    expect(dockerfile).toContain("ARG SOURCE_SHA");
    expect(dockerfile).toContain("ENV LO_SOURCE_SHA=${SOURCE_SHA}");
    expect(verifier).toContain("WORKER_RUNTIME_SQL_IMAGE_SOURCE_DRIFT");
  });
});
