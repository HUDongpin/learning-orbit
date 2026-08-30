import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = resolve(root, "schemas");
const target = resolve(root, "dist/schemas");
const files = (await readdir(source)).filter((name) => name.endsWith(".json")).sort();
await rm(target, { recursive: true, force: true });
await mkdir(dirname(target), { recursive: true });
await mkdir(target, { recursive: true });
await Promise.all(files.map((name) => cp(resolve(source, name), resolve(target, name), { force: true })));
