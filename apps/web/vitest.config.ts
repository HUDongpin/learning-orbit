import { fileURLToPath } from "node:url";

import { defineProject } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineProject({
  test: {
    name: "web",
    root,
    environment: "jsdom",
    setupFiles: ["test/setup.ts"],
    include: ["{app,src,test}/**/*.test.{ts,tsx}"],
  },
});
