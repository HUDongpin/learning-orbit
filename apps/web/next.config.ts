import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

export default function nextConfig(phase: string): NextConfig {
  const localProxyEnabled = process.env.LO_LOCAL_SAME_ORIGIN_PROXY === "1";
  if (localProxyEnabled && phase !== PHASE_DEVELOPMENT_SERVER) {
    throw new Error("LO_LOCAL_SAME_ORIGIN_PROXY_FORBIDDEN");
  }

  return {
    env: {
      // One non-secret canonical value feeds both Fastify validation and the
      // browser bundle; an independently supplied NEXT_PUBLIC value is ignored.
      NEXT_PUBLIC_LO_STORAGE_BROWSER_ORIGINS: process.env.LO_STORAGE_BROWSER_ORIGINS ?? "",
    },
    async rewrites() {
      if (!localProxyEnabled) {
        return [];
      }

      return [
        {
          source: "/v1/:path*",
          destination: "http://127.0.0.1:3001/v1/:path*",
        },
      ];
    },
  };
}
