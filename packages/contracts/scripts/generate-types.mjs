import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFromFile } from "json-schema-to-typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const defaultSchemasDir = join(root, "schemas");
const defaultOutDir = join(root, "src/generated");
const options = { bannerComment: "/* generated; source is JSON Schema */", unreachableDefinitions: true };

function generatorError(code) {
  return new Error(code);
}

async function directoryState(path, absentIsAllowed = false) {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw generatorError("GENERATOR_OUTPUT_INVALID");
    return true;
  } catch (error) {
    if (absentIsAllowed && error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function compileAllSchemas(schemasDir) {
  await directoryState(schemasDir);
  const files = (await readdir(schemasDir)).filter((file) => file.endsWith(".json")).sort();
  if (!files.length) throw generatorError("NO_CONTRACT_SCHEMAS");

  const sourceSchemas = [];
  const generatedModules = [];
  const modules = [];
  for (const file of files) {
    const sourcePath = join(schemasDir, file);
    const raw = await readFile(sourcePath);
    const schema = JSON.parse(raw.toString("utf8"));
    if (typeof schema.$id !== "string") throw generatorError(`SCHEMA_ID_MISSING:${file}`);
    const moduleFile = file.replace(/\.json$/, ".ts");
    modules.push({ moduleFile, source: await compileFromFile(sourcePath, options) });
    sourceSchemas.push({ file, id: schema.$id, sha256: createHash("sha256").update(raw).digest("hex") });
    generatedModules.push({ sourceFile: file, moduleFile, language: "typescript" });
  }
  return { modules, manifest: JSON.stringify({ schemaVersion: 1, sourceSchemas, generatedModules }, null, 2) + "\n" };
}

async function writeStagingDirectory(stage, compiled) {
  for (const module of compiled.modules) await writeFile(join(stage, module.moduleFile), module.source);
  await writeFile(join(stage, "manifest.json"), compiled.manifest);
}

export async function generateTypes({ schemasDir = defaultSchemasDir, outDir = defaultOutDir } = {}) {
  const trustedSchemasDir = resolve(schemasDir);
  const trustedOutDir = resolve(outDir);
  const outParent = dirname(trustedOutDir);
  if (trustedOutDir === outParent) throw generatorError("GENERATOR_OUTPUT_INVALID");

  // No target or lock is touched until every source was read, parsed, and compiled in memory.
  const compiled = await compileAllSchemas(trustedSchemasDir);
  await mkdir(outParent, { recursive: true });
  await directoryState(outParent);
  await directoryState(trustedOutDir, true);

  const lockPath = join(outParent, `${basename(trustedOutDir)}.lock`);
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw generatorError("GENERATOR_OUTPUT_LOCKED");
    throw error;
  }

  let stage;
  let backup;
  try {
    stage = await mkdtemp(join(outParent, `${basename(trustedOutDir)}.stage-`));
    await writeStagingDirectory(stage, compiled);

    const hasExistingOutput = await directoryState(trustedOutDir, true);
    if (hasExistingOutput) {
      backup = await mkdtemp(join(outParent, `${basename(trustedOutDir)}.backup-`));
      await rm(backup, { recursive: true, force: true });
      await rename(trustedOutDir, backup);
    }

    try {
      await rename(stage, trustedOutDir);
      stage = undefined;
    } catch (error) {
      if (backup) {
        await rename(backup, trustedOutDir);
        backup = undefined;
      }
      throw error;
    }

    if (backup) {
      await rm(backup, { recursive: true, force: true });
      backup = undefined;
    }
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    if (backup) {
      const outputExists = await directoryState(trustedOutDir, true);
      if (!outputExists) await rename(backup, trustedOutDir);
      else await rm(backup, { recursive: true, force: true });
    }
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateTypes();
}
