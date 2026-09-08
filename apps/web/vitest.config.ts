import { fileURLToPath } from "node:url";

import { defineProject } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineProject({
  resolve: {
    // Tests read the contracts from the source tree TypeScript checks, the way
    // the server project already does. The package's `import` condition points
    // at `packages/contracts/dist`, which is gitignored, so without this a
    // fresh clone cannot even load these files, and a clone whose build
    // predates a new contract silently loads the old one.
    alias: {
      "@learning-orbit/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    name: "web",
    root,
    environment: "jsdom",
    setupFiles: ["test/setup.ts"],
    include: ["{app,src,test}/**/*.test.{ts,tsx}"],
  },
});
