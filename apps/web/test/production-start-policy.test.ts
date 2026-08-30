import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const FORBIDDEN_ERROR = "LO_LOCAL_SAME_ORIGIN_PROXY_FORBIDDEN";
const webRoot = process.cwd();
const startPath = path.join(webRoot, "scripts/start.mjs");

type StartModule = {
  assertProductionStartPolicy?: (
    environment: Record<string, string | undefined>,
  ) => void;
};

async function loadStartModule(): Promise<StartModule> {
  const module = await import(/* @vite-ignore */ pathToFileURL(startPath).href)
    .catch(() => undefined);

  expect(module, "canonical production start module is missing").toBeDefined();
  return module as StartModule;
}

describe("canonical web production start policy", () => {
  it("rejects the local proxy before Next can emit output or start a listener", () => {
    const result = spawnSync(process.execPath, [startPath, "--help"], {
      encoding: "utf8",
      env: {
        NODE_ENV: "production",
        LO_LOCAL_SAME_ORIGIN_PROXY: "1",
      },
      timeout: 3_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${FORBIDDEN_ERROR}\n`);
  });

  it("delegates allowed argv to Next without starting a long-lived server", () => {
    const result = spawnSync(process.execPath, [startPath, "--help"], {
      encoding: "utf8",
      env: {
        NODE_ENV: "production",
        LO_LOCAL_SAME_ORIGIN_PROXY: "0",
      },
      timeout: 3_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain("Usage: next start");
  });

  it.each([undefined, "", "0", "true", " 1", "1 "])(
    "allows the pure startup policy when the flag is %s",
    async (flag) => {
      const module = await loadStartModule();
      expect(module.assertProductionStartPolicy).toBeTypeOf("function");

      expect(() => module.assertProductionStartPolicy?.({
        LO_LOCAL_SAME_ORIGIN_PROXY: flag,
      })).not.toThrow();
    },
  );

  it("rejects exact flag 1 through the pure startup policy", async () => {
    const module = await loadStartModule();
    expect(module.assertProductionStartPolicy).toBeTypeOf("function");

    expect(() => module.assertProductionStartPolicy?.({
      LO_LOCAL_SAME_ORIGIN_PROXY: "1",
    })).toThrow(FORBIDDEN_ERROR);
  });

  it("owns the exact package start entry", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(webRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(manifest.scripts?.start).toBe("node scripts/start.mjs");
  });
});
