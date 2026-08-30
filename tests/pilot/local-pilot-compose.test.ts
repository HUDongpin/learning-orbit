import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  buildComposeArgv,
  buildComposeEnvironment,
  inspectComposeOwnership,
  assertComposeProjectAbsent,
  verifyComposeResourceLabels,
} from "../../scripts/local-pilot/compose.mjs";
import { buildRunIdentity } from "../../scripts/local-pilot/ownership.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../..");
const composeFile = resolve(repoRoot, "infra/docker-compose.pilot.yml");
const identity = buildRunIdentity({
  runId: "0123456789abcdef",
  sourceSha: "e".repeat(40),
  creatorPid: 9021,
});

describe("run-owned pilot Compose project", () => {
  it("renders one isolated PostgreSQL 18 and pinned Mailpit project", async () => {
    const env = buildComposeEnvironment({
      identity,
      password: "unit-test-password-not-a-real-secret",
      inheritedEnv: { ...process.env, FORBIDDEN_SECRET_SENTINEL: "must-not-propagate" },
    });
    expect(env).not.toHaveProperty("FORBIDDEN_SECRET_SENTINEL");
    const argv = buildComposeArgv({ identity, composeFile, operation: "config" });
    const { stdout } = await execFileAsync("docker", [...argv, "--format", "json"], {
      env,
      maxBuffer: 1024 * 1024,
    });
    const rendered = JSON.parse(stdout) as {
      name: string;
      services: Record<string, {
        image: string;
        environment?: Record<string, string>;
        labels?: Record<string, string>;
        ports?: Array<{ host_ip: string; published: string; target: number }>;
      }>;
      volumes: Record<string, { labels?: Record<string, string> }>;
      networks: Record<string, { labels?: Record<string, string> }>;
    };
    expect(rendered.name).toBe(identity.composeProject);
    expect(Object.keys(rendered.services).sort()).toEqual(["mailpit", "postgres"]);
    expect(rendered.services.postgres?.image).toBe(
      "postgres:18@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280",
    );
    expect(rendered.services.postgres?.environment?.POSTGRES_DB).toBe(identity.databaseName);
    expect(rendered.services.postgres?.ports).toContainEqual(expect.objectContaining({
      host_ip: "127.0.0.1",
      published: "55432",
      target: 5432,
    }));
    expect(rendered.services.mailpit?.image).toBe(
      "axllent/mailpit:v1.31.0@sha256:c96991d9bef73594c246d89ca81411d4e916f03e76a7d2d72fa2ab5dd3c9ce24",
    );
    expect(rendered.services.mailpit?.ports).toEqual(expect.arrayContaining([
      expect.objectContaining({ host_ip: "127.0.0.1", published: "1025", target: 1025 }),
      expect.objectContaining({ host_ip: "127.0.0.1", published: "8025", target: 8025 }),
    ]));
    expect(rendered.volumes.pilot_postgres_data).toBeDefined();
    expect(rendered.networks.default).toBeDefined();
    const source = await readFile(composeFile, "utf8");
    expect(source).not.toContain("name: learning-orbit");
    expect(source).not.toContain("postgres/init");
    expect(source).not.toContain("learning_orbit_test");
  });

  it("keeps credentials out of argv and bounds destructive operations", () => {
    const up = buildComposeArgv({ identity, composeFile, operation: "up" });
    expect(up).toEqual([
      "compose", "--project-name", identity.composeProject, "--file", composeFile,
      "up", "--detach", "--wait", "--remove-orphans",
    ]);
    expect(up.join(" ")).not.toContain("password");
    const marker = {
      runId: identity.runId,
      sourceSha: identity.sourceSha,
      creatorPid: identity.creatorPid,
      composeProject: identity.composeProject,
      databaseName: identity.databaseName,
    };
    const labels = {
      "com.docker.compose.project": identity.composeProject,
      "io.learning-orbit.local-pilot.run-id": identity.runId,
      "io.learning-orbit.local-pilot.database-name": identity.databaseName,
    };
    const ownership = verifyComposeResourceLabels([
      { kind: "container", name: "postgres", labels },
      { kind: "container", name: "mailpit", labels },
      { kind: "volume", name: "pilot_postgres_data", labels },
      { kind: "network", name: "default", labels },
    ], identity, marker);
    expect(buildComposeArgv({ identity, composeFile, operation: "down", ownership })).toEqual([
      "compose", "--project-name", identity.composeProject, "--file", composeFile,
      "down", "--volumes", "--remove-orphans", "--timeout", "10",
    ]);
    expect(() => buildComposeArgv({ identity, composeFile, operation: "down" })).toThrow(
      "LOCAL_PILOT_COMPOSE_OWNERSHIP_REQUIRED",
    );
    expect(() => buildComposeArgv({
      identity,
      composeFile: repoRoot,
      operation: "down",
    })).toThrow("LOCAL_PILOT_COMPOSE_FILE_INVALID");
  });

  it("accepts only resources carrying the exact in-memory ownership tuple", () => {
    const labels = {
      "com.docker.compose.project": identity.composeProject,
      "io.learning-orbit.local-pilot.run-id": identity.runId,
      "io.learning-orbit.local-pilot.database-name": identity.databaseName,
    };
    const marker = {
      runId: identity.runId,
      sourceSha: identity.sourceSha,
      creatorPid: identity.creatorPid,
      composeProject: identity.composeProject,
      databaseName: identity.databaseName,
    };
    expect(() => verifyComposeResourceLabels([
      { kind: "container", name: "postgres", labels },
      { kind: "container", name: "mailpit", labels },
      { kind: "volume", name: "pilot_postgres_data", labels },
      { kind: "network", name: "default", labels },
    ], identity, marker)).not.toThrow();
    expect(() => verifyComposeResourceLabels([
      { kind: "container", name: "postgres", labels: { ...labels, "io.learning-orbit.local-pilot.run-id": "ffffffffffffffff" } },
    ], identity, marker)).toThrow("LOCAL_PILOT_COMPOSE_OWNERSHIP_MISMATCH");
    expect(() => verifyComposeResourceLabels([], identity, marker)).toThrow(
      "LOCAL_PILOT_COMPOSE_RESOURCE_SET_INCOMPLETE",
    );
    expect(() => verifyComposeResourceLabels([
      { kind: "container", name: "postgres", labels },
      { kind: "container", name: "mailpit", labels },
      { kind: "volume", name: "pilot_postgres_data", labels },
      { kind: "network", name: "default", labels },
    ], identity, { ...marker, creatorPid: identity.creatorPid + 1 })).toThrow(
      "LOCAL_PILOT_OWNERSHIP_MISMATCH",
    );
  });

  it("checks project collisions and derives teardown capability only from live inspect labels", async () => {
    const marker = {
      runId: identity.runId,
      sourceSha: identity.sourceSha,
      creatorPid: identity.creatorPid,
      composeProject: identity.composeProject,
      databaseName: identity.databaseName,
    };
    const labels = {
      "com.docker.compose.project": identity.composeProject,
      "io.learning-orbit.local-pilot.run-id": identity.runId,
      "io.learning-orbit.local-pilot.database-name": identity.databaseName,
    };
    const calls: string[][] = [];
    const runDocker = async (argv: string[]) => {
      calls.push(argv);
      const joined = argv.join(" ");
      if (joined.includes("ps --all --filter") || joined.includes("volume ls") || joined.includes("network ls")) {
        return { stdout: "" };
      }
      if (joined.endsWith("ps --quiet postgres")) return { stdout: "postgres-id\n" };
      if (joined.endsWith("ps --quiet mailpit")) return { stdout: "mailpit-id\n" };
      if (joined.includes("inspect --type container")) return { stdout: `${JSON.stringify(labels)}\n` };
      if (joined.includes("volume inspect")) return { stdout: `${JSON.stringify(labels)}\n` };
      if (joined.includes("network inspect")) return { stdout: `${JSON.stringify(labels)}\n` };
      throw new Error("unexpected docker argv");
    };
    await expect(assertComposeProjectAbsent({ identity, runDocker })).resolves.toBeUndefined();
    const ownership = await inspectComposeOwnership({
      identity,
      marker,
      composeFile,
      runDocker,
    });
    expect(buildComposeArgv({ identity, composeFile, operation: "down", ownership })[5]).toBe("down");
    expect(calls.every((argv) => Array.isArray(argv) && !argv.join(" ").includes("password"))).toBe(true);

    await expect(assertComposeProjectAbsent({
      identity,
      runDocker: async () => ({ stdout: "preexisting-resource\n" }),
    })).rejects.toThrow("LOCAL_PILOT_COMPOSE_COLLISION");
    await expect(inspectComposeOwnership({
      identity,
      marker,
      composeFile,
      runDocker: async (argv: string[]) => {
        const result = await runDocker(argv);
        if (argv.includes("mailpit-id")) return { stdout: JSON.stringify({ ...labels, "io.learning-orbit.local-pilot.run-id": "ffffffffffffffff" }) };
        return result;
      },
    })).rejects.toThrow("LOCAL_PILOT_COMPOSE_OWNERSHIP_MISMATCH");
  });
});
