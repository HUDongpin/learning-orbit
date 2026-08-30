import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(scriptDir, "..");
const sourceDir = resolve(serverRoot, "src/db/sql");
const destinationDir = resolve(serverRoot, "dist/src/db/sql");

await rm(destinationDir, { force: true, recursive: true });
await mkdir(destinationDir, { recursive: true });
for (const name of await readdir(sourceDir)) {
  if (name.endsWith(".sql")) await cp(resolve(sourceDir, name), resolve(destinationDir, name));
}
