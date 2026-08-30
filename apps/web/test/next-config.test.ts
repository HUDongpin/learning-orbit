import { afterEach, describe, expect, it } from "vitest";
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_EXPORT,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
} from "next/constants";
import type { NextConfig } from "next";

import nextConfig from "../next.config.js";

const originalEnvironment = {
  LO_LOCAL_SAME_ORIGIN_PROXY: process.env.LO_LOCAL_SAME_ORIGIN_PROXY,
  LO_STORAGE_BROWSER_ORIGINS: process.env.LO_STORAGE_BROWSER_ORIGINS,
  NEXT_PUBLIC_LO_STORAGE_BROWSER_ORIGINS: process.env.NEXT_PUBLIC_LO_STORAGE_BROWSER_ORIGINS,
  NODE_ENV: process.env.NODE_ENV,
};

type Rewrite = {
  source: string;
  destination: string;
};

function setEnvironment(name: keyof typeof originalEnvironment, value: string | undefined) {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }

  Reflect.set(process.env, name, value);
}

afterEach(() => {
  setEnvironment("LO_LOCAL_SAME_ORIGIN_PROXY", originalEnvironment.LO_LOCAL_SAME_ORIGIN_PROXY);
  setEnvironment("LO_STORAGE_BROWSER_ORIGINS", originalEnvironment.LO_STORAGE_BROWSER_ORIGINS);
  setEnvironment("NEXT_PUBLIC_LO_STORAGE_BROWSER_ORIGINS", originalEnvironment.NEXT_PUBLIC_LO_STORAGE_BROWSER_ORIGINS);
  setEnvironment("NODE_ENV", originalEnvironment.NODE_ENV);
});

function configForPhase(phase: string): NextConfig {
  expect(nextConfig).toBeTypeOf("function");
  return (nextConfig as unknown as (value: string) => NextConfig)(phase);
}

async function configuredRewrites(phase = PHASE_DEVELOPMENT_SERVER): Promise<readonly Rewrite[]> {
  const config = configForPhase(phase);
  expect(config.rewrites).toBeTypeOf("function");
  return (await config.rewrites?.()) as readonly Rewrite[];
}

describe("Next.js local same-origin proxy", () => {
  it("derives the public storage allowlist from the same canonical server variable", () => {
    setEnvironment("LO_STORAGE_BROWSER_ORIGINS", "https://storage.learning-orbit.test");
    setEnvironment("NEXT_PUBLIC_LO_STORAGE_BROWSER_ORIGINS", "https://hostile.example");

    expect(configForPhase(PHASE_DEVELOPMENT_SERVER).env).toMatchObject({
      NEXT_PUBLIC_LO_STORAGE_BROWSER_ORIGINS: "https://storage.learning-orbit.test",
    });
  });

  it.each([undefined, "", "0", "true", " 1", "1 "])(
    "returns no rewrites when LO_LOCAL_SAME_ORIGIN_PROXY is %s",
    async (flag) => {
      setEnvironment("LO_LOCAL_SAME_ORIGIN_PROXY", flag);

      await expect(configuredRewrites()).resolves.toEqual([]);
    },
  );

  it("keeps every phase disabled when the flag is not exactly 1", async () => {
    setEnvironment("LO_LOCAL_SAME_ORIGIN_PROXY", "0");

    for (const phase of [
      PHASE_DEVELOPMENT_SERVER,
      PHASE_PRODUCTION_BUILD,
      PHASE_PRODUCTION_SERVER,
      PHASE_EXPORT,
    ]) {
      await expect(configuredRewrites(phase)).resolves.toEqual([]);
    }
  });

  it("proxies only the public /v1 namespace when the local flag is exactly 1", async () => {
    setEnvironment("LO_LOCAL_SAME_ORIGIN_PROXY", "1");

    const rewrites = await configuredRewrites(PHASE_DEVELOPMENT_SERVER);

    expect(rewrites).toEqual([
      {
        source: "/v1/:path*",
        destination: "http://127.0.0.1:3001/v1/:path*",
      },
    ]);
    expect(rewrites).toHaveLength(1);
    expect(rewrites.some(({ source }) => source.startsWith("/internal"))).toBe(false);
  });

  it.each([
    PHASE_PRODUCTION_BUILD,
    PHASE_PRODUCTION_SERVER,
    PHASE_EXPORT,
  ])("rejects local proxy flag in non-development phase %s", (phase) => {
    setEnvironment("NODE_ENV", "test");
    setEnvironment("LO_LOCAL_SAME_ORIGIN_PROXY", "1");

    expect(() => configForPhase(phase)).toThrow(
      "LO_LOCAL_SAME_ORIGIN_PROXY_FORBIDDEN",
    );
  });
});
