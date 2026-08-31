import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export const LOCAL_PILOT_PACKAGE_SCRIPT = "node scripts/verify-local-pilot.mjs";

export async function resolveExecutableFromPath(name, pathValue) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error("LOCAL_PILOT_EXECUTABLE_NAME_INVALID");
  }
  if (typeof pathValue !== "string" || pathValue.includes("\u0000")) {
    throw new Error("LOCAL_PILOT_EXECUTABLE_PATH_INVALID");
  }
  for (const directory of pathValue.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = resolve(join(directory, name));
    try {
      const info = await lstat(candidate);
      if (!info.isFile() && !info.isSymbolicLink()) continue;
      const target = await realpath(candidate);
      const targetInfo = await lstat(target);
      if (!targetInfo.isFile()) continue;
      await access(target, constants.X_OK);
      return candidate;
    } catch {
      // PATH lookup is a bounded search; only the stable final code is public.
    }
  }
  throw new Error("LOCAL_PILOT_EXECUTABLE_UNAVAILABLE");
}
