import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "schemas");
const dist = resolve(root, "dist/schemas");

describe("compiled contract schema resources", () => {
  it("removes stale output, copies every canonical schema, and imports the compiled runtime contract", async () => {
    await execFileAsync(process.execPath, [resolve(root, "../../node_modules/typescript/bin/tsc"), "-p", resolve(root, "tsconfig.json"), "--noEmit", "false"]);
    await mkdir(dist, { recursive: true });
    await writeFile(resolve(dist, "__stale__.json"), "{}\n");
    await execFileAsync(process.execPath, [resolve(root, "scripts/copy-schema-resources.mjs")]);
    const names = (await readdir(source)).filter((name) => name.endsWith(".json")).sort();
    expect((await readdir(dist)).sort()).toEqual(names);
    for (const name of names) expect(await readFile(resolve(dist, name), "utf8")).toBe(await readFile(resolve(source, name), "utf8"));
    const module = await import(`${pathToFileURL(resolve(root, "dist/src/index.js")).href}?resource-test=${Date.now()}`);
    expect(module.authContract.parseTeacherMagicLinkRequest({ email: "teacher@example.edu" })).toEqual({ email: "teacher@example.edu" });
  });
});
