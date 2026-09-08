import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { assertTestProjectOwnership } from "./scripts/assert-test-project-ownership.mjs";

// Every project resolves the contracts to the source tree TypeScript checks.
// The package's `import` condition points at `packages/contracts/dist`, which
// is gitignored: a fresh clone has none, and a clone built before a contract
// landed has an old one that resolves the new name to nothing. Neither belongs
// in a test run, and each project needs saying because a project loaded from
// its own file does not inherit this one's resolution.
const contractsSource = {
  "@learning-orbit/contracts": fileURLToPath(
    new URL("packages/contracts/src/index.ts", import.meta.url),
  ),
};

export default defineConfig(async () => {
  await assertTestProjectOwnership(new URL(".", import.meta.url));

  return {
    test: {
      projects: [
        "apps/server/vitest.config.ts",
        "apps/web/vitest.config.ts",
        "packages/contracts/vitest.config.ts",
        {
          resolve: { alias: contractsSource },
          test: {
            name: "cross-node",
            environment: "node",
            include: ["tests/{integration,chaos,pilot}/**/*.test.ts"],
          },
        },
        {
          resolve: { alias: contractsSource },
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
