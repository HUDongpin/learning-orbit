import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const sourceSql = resolve(repoRoot, "apps/server/src/db/sql");
const distSql = resolve(repoRoot, "apps/server/dist/src/db/sql");
const execFileAsync = promisify(execFile);

describe("deployment-safe configuration and build resources", () => {
  it("documents only empty room-code pepper variable slots", async () => {
    const example = await readFile(resolve(repoRoot, ".env.example"), "utf8");
    expect(example).toContain("ROOM_CODE_PEPPER_CURRENT_VERSION=\n");
    expect(example).toContain("ROOM_CODE_PEPPER_V1=\n");
    expect(example).not.toMatch(/ROOM_CODE_PEPPER_(?:CURRENT_VERSION|V[0-9]+)=.+/);
  });

  it("binds Postgres locally and requires an injected password", async () => {
    const composePath = resolve(repoRoot, "infra/docker-compose.yml");
    const compose = await readFile(composePath, "utf8");
    expect(compose).toMatch(/ports:\s*\n\s+- ['"]127\.0\.0\.1:55432:5432['"]/);
    expect(compose).toMatch(/POSTGRES_PASSWORD:\s*\$\{LO_POSTGRES_PASSWORD:\?LO_POSTGRES_PASSWORD is required\}/);
    expect(compose).not.toMatch(/POSTGRES_PASSWORD:\s*['"]?learning_orbit\b/);
    expect(compose).toMatch(/test:\s*\["CMD-SHELL",\s*"pg_isready -U \$\$\{POSTGRES_USER\} -d \$\$\{POSTGRES_DB\}"\]/);

    const sentinelPassword = "learning-orbit-compose-test-sentinel";
    // Every `${VAR:?...}` in the file is supplied here, and the ambient
    // environment is not inherited. Passing `...process.env` let a developer's
    // own .env satisfy the storage credentials MinIO added later, so the test
    // passed at a workstation and failed inside the pilot harness, which hands
    // its gates a restricted environment. What the compose file requires is
    // part of what this test is asserting; it cannot be borrowed.
    const { stdout } = await execFileAsync(
      "docker",
      ["compose", "-f", composePath, "config", "--format", "json"],
      {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
          ...(process.env.DOCKER_CONTEXT ? { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT } : {}),
          ...(process.env.DOCKER_CONFIG ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG } : {}),
          LO_POSTGRES_PASSWORD: sentinelPassword,
          LO_STORAGE_ACCESS_KEY_ID: "learning-orbit-compose-test-access-key",
          LO_STORAGE_SECRET_ACCESS_KEY: "learning-orbit-compose-test-secret-key",
        },
      },
    );
    const rendered = JSON.parse(stdout) as {
      services: {
        postgres: {
          environment: Record<string, string>;
          ports: Array<{ host_ip: string; published: string; target: number }>;
        };
      };
    };
    expect(rendered.services.postgres.environment.POSTGRES_PASSWORD).toBe(sentinelPassword);
    expect(rendered.services.postgres.ports).toContainEqual({
      host_ip: "127.0.0.1",
      mode: "ingress",
      protocol: "tcp",
      published: "55432",
      target: 5432,
    });
  });

  it("copies the complete canonical SQL set byte-for-byte into dist", async () => {
    await mkdir(distSql, { recursive: true });
    await writeFile(resolve(distSql, "__stale__.sql"), "SELECT 'stale';\n");
    await execFileAsync(process.execPath, [resolve(repoRoot, "apps/server/scripts/copy-sql-resources.mjs")]);
    const [sourceNames, distNames] = await Promise.all([readdir(sourceSql), readdir(distSql)]);
    const sqlNames = (names: string[]) => names.filter((name) => name.endsWith(".sql")).sort();
    expect(sqlNames(distNames)).toEqual(sqlNames(sourceNames));
    for (const name of sqlNames(sourceNames)) {
      expect(await readFile(resolve(distSql, name), "utf8")).toBe(await readFile(resolve(sourceSql, name), "utf8"));
    }
  });
});
