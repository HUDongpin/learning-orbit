import { readFile } from "node:fs/promises";

const lock = await readFile(
  new URL("../services/worker/requirements.lock", import.meta.url),
  "utf8",
);
const pyproject = await readFile(
  new URL("../services/worker/pyproject.toml", import.meta.url),
  "utf8",
);

const requiredCompileCommand =
  "python -m piptools compile --generate-hashes --resolver=backtracking --output-file services/worker/requirements.lock services/worker/pyproject.toml";
const compileCommands = [...lock.matchAll(/^#\s{4}(.+)$/gm)].map(
  ([, command]) => command,
);
if (compileCommands.length !== 1) {
  throw new Error(`PYTHON_LOCK_PROVENANCE_COUNT:${compileCommands.length}`);
}
if (compileCommands[0] !== requiredCompileCommand) {
  throw new Error("PYTHON_LOCK_PROVENANCE_INVALID");
}

const generatedMinor = lock.match(/with Python (\d+)\.(\d+)/);
if (!generatedMinor || generatedMinor[1] !== "3" || generatedMinor[2] !== "12") {
  throw new Error(
    `PYTHON_LOCK_MINOR:${generatedMinor?.slice(1).join(".") ?? "missing"}`,
  );
}

const logicalRequirements = [];
let current = "";
for (const line of lock.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    (trimmed.startsWith("--") && !trimmed.startsWith("--hash=sha256:"))
  ) {
    continue;
  }

  const withoutContinuation = trimmed.endsWith("\\")
    ? trimmed.slice(0, -1).trimEnd()
    : trimmed;
  current = current ? `${current} ${withoutContinuation}` : withoutContinuation;
  if (!trimmed.endsWith("\\")) {
    logicalRequirements.push(current);
    current = "";
  }
}

if (current) {
  throw new Error("PYTHON_LOCK_CONTINUATION:unterminated");
}

const lockedNames = new Set();
const lockedDirect = [];
const invalidRequirements = [];
for (const requirement of logicalRequirements) {
  const requirementPart = requirement.split(/\s+(?=--hash=sha256:)/)[0];
  const hashes = [...requirement.matchAll(/(?:^|\s)--hash=sha256:[0-9a-f]{64}(?=\s|$)/g)];
  const exact = requirementPart.match(
    /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[([^\]]+)\])?==([^\s;]+)(?:\s*;\s*(.+))?$/,
  );
  if (!exact || hashes.length === 0) {
    invalidRequirements.push(requirement);
    continue;
  }
  const name = exact[1].toLowerCase().replace(/[._]/g, "-");
  const extras = (exact[2] ?? "").split(",").filter(Boolean).map((e) => e.trim().toLowerCase().replace(/[._]/g, "-")).sort();
  lockedNames.add(name);
  lockedDirect.push({ name, extras, version: exact[3] });
}

if (invalidRequirements.length) {
  throw new Error(
    `PYTHON_LOCK_REQUIREMENTS:${JSON.stringify(invalidRequirements)}`,
  );
}

const dependencyBlock = pyproject.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
if (!dependencyBlock) {
  throw new Error("PYTHON_DIRECT_DEPENDENCIES:missing-project-block");
}

const directRequirements = [...dependencyBlock[1].matchAll(/"([^"\n]+)"/g)].map(
  ([, dependency]) => {
    const match = dependency.match(
      /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[([^\]]+)\])?==([^\s]+)$/,
    );
    if (!match) {
      throw new Error(`PYTHON_DIRECT_DEPENDENCY_NOT_EXACT:${dependency}`);
    }
    return { name: match[1].toLowerCase().replace(/[._]/g, "-"), extras: (match[2] ?? "").split(",").filter(Boolean).map((e) => e.trim().toLowerCase().replace(/[._]/g, "-")).sort(), version: match[3] };
  },
);
const missingDirect = directRequirements.filter((direct) => !lockedDirect.some((locked) => locked.name === direct.name && locked.version === direct.version && JSON.stringify(locked.extras) === JSON.stringify(direct.extras)));
if (missingDirect.length) {
  throw new Error(`PYTHON_DIRECT_DEPENDENCIES:${JSON.stringify(missingDirect.map(({ name }) => name))}`);
}

console.log("python-lock: PASS");
