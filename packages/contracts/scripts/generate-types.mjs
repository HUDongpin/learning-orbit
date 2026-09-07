import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFromFile } from "json-schema-to-typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const defaultSchemasDir = join(root, "schemas");
const defaultOutDir = join(root, "src/generated");
const defaultWorkerDir = resolve(
  root,
  "../../services/worker/src/learning_orbit_worker/generated",
);
/** Schemas the Python worker must be able to parse are marked in the schema itself. */
const PYTHON_INGRESS_KEY = "x-learning-orbit-python-ingress";
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
  const pythonIngress = [];
  const modules = [];
  for (const file of files) {
    const sourcePath = join(schemasDir, file);
    const raw = await readFile(sourcePath);
    const schema = JSON.parse(raw.toString("utf8"));
    if (typeof schema.$id !== "string") throw generatorError(`SCHEMA_ID_MISSING:${file}`);
    const moduleFile = file.replace(/\.json$/, ".ts");
    modules.push({ moduleFile, source: await compileFromFile(sourcePath, options) });
    const sha256 = createHash("sha256").update(raw).digest("hex");
    sourceSchemas.push({ file, id: schema.$id, sha256 });
    generatedModules.push({ sourceFile: file, moduleFile, language: "typescript" });
    if (schema[PYTHON_INGRESS_KEY] === true) {
      pythonIngress.push({
        file,
        id: schema.$id,
        sha256,
        sourcePath: `packages/contracts/schemas/${file}`,
        moduleFile: `${file.replace(/\.json$/, "").replace(/[.-]/g, "_")}.py`,
      });
    }
  }
  return {
    modules,
    pythonIngress,
    manifest: JSON.stringify({ schemaVersion: 1, sourceSchemas, generatedModules }, null, 2) + "\n",
  };
}

/**
 * Write the worker's contract manifest and refuse a Python-ingress schema that
 * has no worker module.
 *
 * The manifest was hand-maintained, so two of its entries carried no digest at
 * all and nothing noticed when a new signed route arrived with no worker-side
 * contract - the worker could not have parsed a request it is required to
 * send. Ownership moves here: every Python-ingress schema is listed with the
 * digest of the exact schema its module parses, and a missing module fails
 * generation rather than shipping.
 */
async function writePythonManifest(workerDir, pythonIngress) {
  if (!(await directoryState(workerDir, true))) return;
  const missing = [];
  for (const entry of pythonIngress) {
    try {
      const info = await lstat(join(workerDir, entry.moduleFile));
      if (!info.isFile()) missing.push(entry.moduleFile);
    } catch {
      missing.push(entry.moduleFile);
    }
  }
  if (missing.length) throw generatorError(`PYTHON_INGRESS_MODULE_MISSING:${missing.join(",")}`);
  const manifest = {
    schemaVersion: 1,
    sourceSchemas: pythonIngress.map(({ file, id, sha256, sourcePath }) => ({
      file, id, language: "python-ingress", sha256, sourcePath,
    })),
    generatedModules: pythonIngress.map(({ file, moduleFile }) => ({
      sourceFile: file, moduleFile, language: "python",
    })),
  };
  await writeFile(join(workerDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function writeStagingDirectory(stage, compiled) {
  for (const module of compiled.modules) await writeFile(join(stage, module.moduleFile), module.source);
  await writeFile(join(stage, "manifest.json"), compiled.manifest);
}

export async function generateTypes({ schemasDir = defaultSchemasDir, outDir = defaultOutDir, workerDir = defaultWorkerDir } = {}) {
  const trustedSchemasDir = resolve(schemasDir);
  const trustedOutDir = resolve(outDir);
  const outParent = dirname(trustedOutDir);
  if (trustedOutDir === outParent) throw generatorError("GENERATOR_OUTPUT_INVALID");

  // No target or lock is touched until every source was read, parsed, and compiled in memory.
  const compiled = await compileAllSchemas(trustedSchemasDir);
  // Checked before any output moves: a missing worker module must fail the
  // whole generation, not leave one language ahead of the other.
  await writePythonManifest(resolve(workerDir), compiled.pythonIngress);
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
