import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "server",
    root: fileURLToPath(new URL(".", import.meta.url)),
    environment: "node",
    include: ["test/**/*.test.ts"],
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
  },
});
