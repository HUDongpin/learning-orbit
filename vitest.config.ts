import { defineConfig } from "vitest/config";

import { assertTestProjectOwnership } from "./scripts/assert-test-project-ownership.mjs";

export default defineConfig(async () => {
  await assertTestProjectOwnership(new URL(".", import.meta.url));

  return {
    test: {
      projects: [
        "apps/server/vitest.config.ts",
        "apps/web/vitest.config.ts",
        "packages/contracts/vitest.config.ts",
        {
          test: {
            name: "cross-node",
            environment: "node",
            include: ["tests/{integration,chaos,pilot}/**/*.test.ts"],
          },
        },
        {
          test: {
            name: "cross-security",
            environment: "jsdom",
            setupFiles: ["apps/web/test/setup.ts"],
            include: ["tests/security/**/*.test.{ts,tsx}"],
          },
        },
      ],
    },
  };
});
