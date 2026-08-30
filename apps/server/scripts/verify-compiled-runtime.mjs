import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const entry = pathToFileURL(resolve(import.meta.dirname, "../dist/src/index.js")).href;
const compiled = await import(`${entry}?compiled-runtime=${Date.now()}`);

if (typeof compiled.buildApp !== "function" || typeof compiled.assertRealtimeOrigin !== "function") {
  throw new Error("SERVER_COMPILED_RUNTIME_INVALID");
}
