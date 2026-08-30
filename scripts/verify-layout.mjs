import { readFile, stat } from "node:fs/promises";

const expectedNodeEngine = ">=24.19.0 <24.20.0";
const files = [
  "package.json",
  "pnpm-workspace.yaml",
  "vitest.config.ts",
  "apps/web/package.json",
  "apps/web/vitest.config.ts",
  "apps/server/package.json",
  "apps/server/vitest.config.ts",
  "packages/contracts/package.json",
  "packages/contracts/vitest.config.ts",
  "services/worker/pyproject.toml",
];

if (!/^24\.19\.\d+$/.test(process.versions.node)) {
  console.error(`node-version: expected 24.19.x, received ${process.versions.node}`);
  process.exit(1);
}

const missing = [];
for (const file of files) {
  try {
    if (!(await stat(new URL(`../${file}`, import.meta.url))).isFile()) {
      missing.push(file);
    }
  } catch {
    missing.push(file);
  }
}

if (missing.length) {
  console.error(`missing:\n${missing.join("\n")}`);
  process.exit(1);
}

const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
if (manifest.engines?.node !== expectedNodeEngine) {
  console.error(
    `node-engine: expected ${expectedNodeEngine}, received ${manifest.engines?.node ?? "missing"}`,
  );
  process.exit(1);
}

console.log("layout: PASS");
