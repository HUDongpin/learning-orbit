import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ownerPatterns = [
  /^apps\/server\/test\/.*\.test\.ts$/,
  /^apps\/web\/(app|src|test)\/.*\.test\.(ts|tsx)$/,
  /^packages\/contracts\/test\/.*\.test\.ts$/,
  /^tests\/(integration|chaos|pilot)\/.*\.test\.ts$/,
  /^tests\/security\/.*\.test\.(ts|tsx)$/,
];
const excludedDirectories = new Set([
  "node_modules",
  ".git",
  ".next",
  "test-results",
]);

export async function assertTestProjectOwnership(rootUrl) {
  const root = fileURLToPath(rootUrl);
  const files = [];

  async function walk(directory, relative = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) {
        continue;
      }

      const nextRelative = relative
        ? `${relative}/${entry.name}`
        : entry.name;
      const nextPath = `${directory}/${entry.name}`;

      if (entry.isDirectory()) {
        await walk(nextPath, nextRelative);
      } else if (/\.test\.(ts|tsx)$/.test(nextRelative)) {
        files.push(nextRelative);
      }
    }
  }

  await walk(root);
  const bad = files.sort()
    .map((file) => ({
      file,
      count: ownerPatterns.filter((pattern) => pattern.test(file)).length,
    }))
    .filter(({ count }) => count !== 1);

  if (bad.length) {
    throw new Error(`VITEST_PROJECT_OWNERSHIP:${JSON.stringify(bad)}`);
  }
}
