import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const nextEnvironmentDeclaration = "apps/web/next-env.d.ts";

describe("Next generated declaration boundary", () => {
  it("keeps next-env untracked, ignored, and generated before typecheck", async () => {
    let ignored = false;
    try {
      execFileSync("git", ["check-ignore", "--quiet", "--", nextEnvironmentDeclaration], {
        cwd: root,
        stdio: "ignore",
      });
      ignored = true;
    } catch {
      ignored = false;
    }
    const tracked = execFileSync("git", ["ls-files", "--", nextEnvironmentDeclaration], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const webPackage = JSON.parse(await readFile(resolve(root, "apps/web/package.json"), "utf8"));

    expect({ ignored, tracked, typecheck: webPackage.scripts?.typecheck }).toEqual({
      ignored: true,
      tracked: "",
      typecheck: "next typegen && tsc -p tsconfig.json --noEmit",
    });
  });
});
