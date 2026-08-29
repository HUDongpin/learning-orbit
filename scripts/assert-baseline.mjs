import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const baseline = JSON.parse(readFileSync(new URL("../packages/test-fixtures/prototype/baseline.json", import.meta.url)));
for (const [name, expected] of Object.entries(baseline.sha256)) {
  const actual = createHash("sha256").update(readFileSync(new URL(`../packages/test-fixtures/prototype/${name}`, import.meta.url))).digest("hex");
  if (actual !== expected) throw new Error(`${name} baseline mismatch: ${actual}`);
}
console.log("prototype baseline: pass");
