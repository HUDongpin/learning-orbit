import { readFile } from "node:fs/promises";

import { assertTestProjectOwnership } from "./assert-test-project-ownership.mjs";

const rootUrl = new URL("../", import.meta.url);
const expectedScripts = {
  build: "pnpm -r build",
  typecheck: "pnpm -r typecheck",
  test: "pnpm -r test",
  "contracts:generate": "pnpm --filter @learning-orbit/contracts generate",
  "test:contracts": "pnpm --filter @learning-orbit/contracts test",
  "test:server": "pnpm --filter @learning-orbit/server test",
  "test:realtime": "pnpm --filter @learning-orbit/server test -- realtime",
  "test:web": "pnpm --filter @learning-orbit/web test",
  "db:migrate": "pnpm --filter @learning-orbit/server db:migrate",
  "db:migrate:test": "pnpm --filter @learning-orbit/server db:migrate:test",
  playwright: "playwright test --config apps/web/playwright.config.ts",
};

const manifest = JSON.parse(
  await readFile(new URL("package.json", rootUrl), "utf8"),
);
const mismatches = Object.entries(expectedScripts)
  .filter(([name, command]) => manifest.scripts?.[name] !== command)
  .map(([name, command]) => ({
    name,
    expected: command,
    actual: manifest.scripts?.[name] ?? null,
  }));

if (mismatches.length) {
  throw new Error(`ROOT_SCRIPTS:${JSON.stringify(mismatches)}`);
}

await assertTestProjectOwnership(rootUrl);
console.log("root-scripts: PASS");
