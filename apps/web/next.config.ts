import type { NextConfig } from "next";

if (
  process.env.NODE_ENV === "production"
  && process.env.LO_LOCAL_SAME_ORIGIN_PROXY === "1"
) {
  throw new Error("LO_LOCAL_SAME_ORIGIN_PROXY_FORBIDDEN");
}

const nextConfig: NextConfig = {
  async rewrites() {
    if (process.env.LO_LOCAL_SAME_ORIGIN_PROXY !== "1") {
      return [];
    }

    if (process.env.NODE_ENV === "production") {
      throw new Error("LO_LOCAL_SAME_ORIGIN_PROXY_FORBIDDEN");
    }

    return [
      {
        source: "/v1/:path*",
        destination: "http://127.0.0.1:3001/v1/:path*",
      },
    ];
  },
};

export default nextConfig;
