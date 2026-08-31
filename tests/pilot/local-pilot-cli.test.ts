import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  LOCAL_PILOT_PACKAGE_SCRIPT,
  resolveExecutableFromPath,
} from "../../scripts/local-pilot/cli.mjs";

const root = resolve(import.meta.dirname, "../..");

describe("verify:local-pilot root entrypoint", () => {
  it("is the one exact root package command", async () => {
    const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    expect(LOCAL_PILOT_PACKAGE_SCRIPT).toBe("node scripts/verify-local-pilot.mjs");
    expect(manifest.scripts["verify:local-pilot"]).toBe(LOCAL_PILOT_PACKAGE_SCRIPT);
  });

  it("resolves a direct executable from a closed PATH without a shell", async () => {
    await expect(resolveExecutableFromPath("node", "/definitely/missing:/usr/local/bin"))
      .resolves.toBe("/usr/local/bin/node");
    await expect(resolveExecutableFromPath("pnpm", "/definitely/missing"))
      .rejects.toThrow("LOCAL_PILOT_EXECUTABLE_UNAVAILABLE");
    await expect(resolveExecutableFromPath("../pnpm", "/usr/local/bin"))
      .rejects.toThrow("LOCAL_PILOT_EXECUTABLE_NAME_INVALID");
  });
});
