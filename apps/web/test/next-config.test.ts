import { afterEach, describe, expect, it, vi } from "vitest";

import nextConfig from "../next.config.js";

const originalEnvironment = {
  LO_LOCAL_SAME_ORIGIN_PROXY: process.env.LO_LOCAL_SAME_ORIGIN_PROXY,
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
  setEnvironment("NODE_ENV", originalEnvironment.NODE_ENV);
});

async function configuredRewrites(): Promise<readonly Rewrite[]> {
  expect(nextConfig.rewrites).toBeTypeOf("function");
  return (await nextConfig.rewrites?.()) as readonly Rewrite[];
}

describe("Next.js local same-origin proxy", () => {
  it.each([undefined, "", "0", "true", " 1", "1 "])(
    "returns no rewrites when LO_LOCAL_SAME_ORIGIN_PROXY is %s",
    async (flag) => {
      setEnvironment("NODE_ENV", "development");
      setEnvironment("LO_LOCAL_SAME_ORIGIN_PROXY", flag);

      await expect(configuredRewrites()).resolves.toEqual([]);
    },
  );

  it("keeps production disabled when the flag is not exactly 1", async () => {
    setEnvironment("NODE_ENV", "production");
    setEnvironment("LO_LOCAL_SAME_ORIGIN_PROXY", "0");

    await expect(configuredRewrites()).resolves.toEqual([]);
  });

  it("proxies only the public /v1 namespace when the local flag is exactly 1", async () => {
    setEnvironment("NODE_ENV", "test");
    setEnvironment("LO_LOCAL_SAME_ORIGIN_PROXY", "1");

    const rewrites = await configuredRewrites();

    expect(rewrites).toEqual([
      {
        source: "/v1/:path*",
        destination: "http://127.0.0.1:3001/v1/:path*",
      },
    ]);
    expect(rewrites).toHaveLength(1);
    expect(rewrites.some(({ source }) => source.startsWith("/internal"))).toBe(false);
  });

  it("fails closed with a stable error when the local proxy is enabled in production", async () => {
    setEnvironment("NODE_ENV", "production");
    setEnvironment("LO_LOCAL_SAME_ORIGIN_PROXY", "1");

    await expect(configuredRewrites()).rejects.toEqual(
      new Error("LO_LOCAL_SAME_ORIGIN_PROXY_FORBIDDEN"),
    );
  });

  it("rejects production configuration during module initialization", async () => {
    setEnvironment("NODE_ENV", "production");
    setEnvironment("LO_LOCAL_SAME_ORIGIN_PROXY", "1");
    vi.resetModules();

    await expect(import("../next.config.js")).rejects.toEqual(
      new Error("LO_LOCAL_SAME_ORIGIN_PROXY_FORBIDDEN"),
    );
  });
});
