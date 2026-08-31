import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";

import { assertOwnershipMarker, buildRunIdentity } from "./ownership.mjs";

const composeOwnershipCapability = Symbol("composeOwnershipCapability");
const expectedComposeResources = new Set([
  "container:postgres",
  "container:mailpit",
  "volume:pilot_postgres_data",
  "network:default",
]);

const fail = (code) => {
  throw new Error(code);
};

function assertIdentity(identity) {
  const rebuilt = buildRunIdentity(identity);
  if (rebuilt.composeProject !== identity.composeProject
    || rebuilt.databaseName !== identity.databaseName) {
    fail("LOCAL_PILOT_IDENTITY_INVALID");
  }
}

function assertComposeFile(composeFile) {
  if (!isAbsolute(composeFile) || basename(composeFile) !== "docker-compose.pilot.yml"
    || basename(dirname(composeFile)) !== "infra") {
    fail("LOCAL_PILOT_COMPOSE_FILE_INVALID");
  }
  try {
    const info = lstatSync(composeFile);
    if (!info.isFile() || info.isSymbolicLink()) fail("LOCAL_PILOT_COMPOSE_FILE_INVALID");
  } catch {
    fail("LOCAL_PILOT_COMPOSE_FILE_INVALID");
  }
}

export function buildComposeEnvironment({ identity, password, inheritedEnv = process.env }) {
  assertIdentity(identity);
  if (typeof password !== "string" || password.length < 24 || password.length > 256
    || /[\r\n\u0000]/.test(password)) {
    fail("LOCAL_PILOT_POSTGRES_PASSWORD_INVALID");
  }
  const environment = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]) {
    const value = inheritedEnv[name];
    if (typeof value === "string" && value.length > 0 && !value.includes("\u0000")) {
      environment[name] = value;
    }
  }
  if (!environment.PATH) fail("LOCAL_PILOT_COMPOSE_ENVIRONMENT_INVALID");
  return {
    ...environment,
    COMPOSE_PROJECT_NAME: identity.composeProject,
    LO_PILOT_RUN_ID: identity.runId,
    LO_PILOT_POSTGRES_DB: identity.databaseName,
    LO_POSTGRES_PASSWORD: password,
  };
}

export function buildComposeArgv({ identity, composeFile, operation, ownership }) {
  assertIdentity(identity);
  assertComposeFile(composeFile);
  const prefix = [
    "compose", "--project-name", identity.composeProject, "--file", composeFile,
  ];
  if (operation === "config") return Object.freeze([...prefix, "config"]);
  if (operation === "up") {
    return Object.freeze([...prefix, "up", "--detach", "--wait", "--remove-orphans"]);
  }
  if (operation === "down") {
    if (!ownership || ownership[composeOwnershipCapability] !== true
      || ownership.runId !== identity.runId
      || ownership.composeProject !== identity.composeProject
      || ownership.databaseName !== identity.databaseName
      || ownership.sourceSha !== identity.sourceSha
      || ownership.creatorPid !== identity.creatorPid) {
      fail("LOCAL_PILOT_COMPOSE_OWNERSHIP_REQUIRED");
    }
    return Object.freeze([...prefix, "down", "--volumes", "--remove-orphans", "--timeout", "10"]);
  }
  fail("LOCAL_PILOT_COMPOSE_OPERATION_INVALID");
}

function verifyResourceLabels(resources, identity, marker, requireComplete) {
  assertIdentity(identity);
  assertOwnershipMarker(marker, identity);
  if (!Array.isArray(resources)) fail("LOCAL_PILOT_COMPOSE_RESOURCE_SET_INCOMPLETE");
  const observed = new Set();
  for (const resource of resources) {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)
      || !expectedComposeResources.has(`${resource.kind}:${resource.name}`)
      || observed.has(`${resource.kind}:${resource.name}`)) {
      fail("LOCAL_PILOT_COMPOSE_RESOURCE_SET_INCOMPLETE");
    }
    const labels = resource.labels;
    if (!labels || typeof labels !== "object" || Array.isArray(labels)
      || labels["com.docker.compose.project"] !== identity.composeProject
      || labels["io.learning-orbit.local-pilot.run-id"] !== identity.runId
      || labels["io.learning-orbit.local-pilot.database-name"] !== identity.databaseName) {
      fail("LOCAL_PILOT_COMPOSE_OWNERSHIP_MISMATCH");
    }
    observed.add(`${resource.kind}:${resource.name}`);
  }
  if (requireComplete
    && (observed.size !== expectedComposeResources.size
      || [...expectedComposeResources].some((item) => !observed.has(item)))) {
    fail("LOCAL_PILOT_COMPOSE_RESOURCE_SET_INCOMPLETE");
  }
  if (!requireComplete && observed.size === 0) return null;
  return Object.freeze({
    [composeOwnershipCapability]: true,
    runId: identity.runId,
    sourceSha: identity.sourceSha,
    creatorPid: identity.creatorPid,
    composeProject: identity.composeProject,
    databaseName: identity.databaseName,
  });
}

export function verifyComposeResourceLabels(resources, identity, marker) {
  return verifyResourceLabels(resources, identity, marker, true);
}

/**
 * A failed `compose up` may leave only a subset of the declared project.  The
 * unique project was proved absent immediately before startup, but cleanup
 * still revalidates every live resource label and the run-owned marker before
 * deriving the destructive `down` capability.  Unknown resources or labels
 * always fail closed.
 */
export function verifyComposeCleanupResourceLabels(resources, identity, marker) {
  return verifyResourceLabels(resources, identity, marker, false);
}

function boundedOutput(result, code) {
  if (!result || typeof result.stdout !== "string"
    || Buffer.byteLength(result.stdout, "utf8") > 65_536 || result.stdout.includes("\u0000")) {
    fail(code);
  }
  return result.stdout.trim();
}

export async function assertComposeProjectAbsent({ identity, runDocker }) {
  assertIdentity(identity);
  if (typeof runDocker !== "function") fail("LOCAL_PILOT_COMPOSE_PREFLIGHT_INVALID");
  const filter = `label=com.docker.compose.project=${identity.composeProject}`;
  const commands = [
    ["ps", "--all", "--filter", filter, "--format", "{{.ID}}"],
    ["volume", "ls", "--filter", filter, "--format", "{{.Name}}"],
    ["network", "ls", "--filter", filter, "--format", "{{.Name}}"],
  ];
  try {
    for (const argv of commands) {
      if (boundedOutput(await runDocker(argv), "LOCAL_PILOT_COMPOSE_PREFLIGHT_FAILED") !== "") {
        fail("LOCAL_PILOT_COMPOSE_COLLISION");
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === "LOCAL_PILOT_COMPOSE_COLLISION") throw error;
    fail("LOCAL_PILOT_COMPOSE_PREFLIGHT_FAILED");
  }
}

function parseLabels(result) {
  const text = boundedOutput(result, "LOCAL_PILOT_COMPOSE_INSPECT_FAILED");
  let labels;
  try {
    labels = JSON.parse(text);
  } catch {
    fail("LOCAL_PILOT_COMPOSE_INSPECT_FAILED");
  }
  if (!labels || typeof labels !== "object" || Array.isArray(labels)
    || Object.entries(labels).some(([key, value]) => typeof key !== "string" || typeof value !== "string")) {
    fail("LOCAL_PILOT_COMPOSE_INSPECT_FAILED");
  }
  return labels;
}

function outputLines(result, code) {
  const text = boundedOutput(result, code);
  return text === "" ? [] : text.split("\n");
}

export async function inspectComposeCleanupOwnership({
  identity,
  marker,
  composeFile,
  runDocker,
}) {
  assertIdentity(identity);
  assertComposeFile(composeFile);
  assertOwnershipMarker(marker, identity);
  if (typeof runDocker !== "function") fail("LOCAL_PILOT_COMPOSE_CLEANUP_INSPECT_FAILED");
  const filter = `label=com.docker.compose.project=${identity.composeProject}`;
  try {
    const resources = [];
    const containers = outputLines(await runDocker([
      "ps", "--all", "--filter", filter,
      "--format", "{{.ID}}|{{.Label \"com.docker.compose.service\"}}",
    ]), "LOCAL_PILOT_COMPOSE_CLEANUP_INSPECT_FAILED");
    for (const line of containers) {
      const match = /^([A-Za-z0-9_-]{1,128})\|(postgres|mailpit)$/.exec(line);
      if (!match) fail("LOCAL_PILOT_COMPOSE_RESOURCE_SET_INCOMPLETE");
      resources.push({
        kind: "container",
        name: match[2],
        labels: parseLabels(await runDocker([
          "inspect", "--type", "container", "--format", "{{json .Config.Labels}}", match[1],
        ])),
      });
    }

    const volumeName = `${identity.composeProject}_pilot_postgres_data`;
    const volumes = outputLines(await runDocker([
      "volume", "ls", "--filter", filter, "--format", "{{.Name}}",
    ]), "LOCAL_PILOT_COMPOSE_CLEANUP_INSPECT_FAILED");
    for (const name of volumes) {
      if (name !== volumeName) fail("LOCAL_PILOT_COMPOSE_RESOURCE_SET_INCOMPLETE");
      resources.push({
        kind: "volume",
        name: "pilot_postgres_data",
        labels: parseLabels(await runDocker([
          "volume", "inspect", "--format", "{{json .Labels}}", name,
        ])),
      });
    }

    const networkName = `${identity.composeProject}_default`;
    const networks = outputLines(await runDocker([
      "network", "ls", "--filter", filter, "--format", "{{.Name}}",
    ]), "LOCAL_PILOT_COMPOSE_CLEANUP_INSPECT_FAILED");
    for (const name of networks) {
      if (name !== networkName) fail("LOCAL_PILOT_COMPOSE_RESOURCE_SET_INCOMPLETE");
      resources.push({
        kind: "network",
        name: "default",
        labels: parseLabels(await runDocker([
          "network", "inspect", "--format", "{{json .Labels}}", name,
        ])),
      });
    }
    return verifyComposeCleanupResourceLabels(resources, identity, marker);
  } catch (error) {
    if (error instanceof Error && [
      "LOCAL_PILOT_COMPOSE_OWNERSHIP_MISMATCH",
      "LOCAL_PILOT_COMPOSE_RESOURCE_SET_INCOMPLETE",
      "LOCAL_PILOT_OWNERSHIP_MISMATCH",
    ].includes(error.message)) throw error;
    fail("LOCAL_PILOT_COMPOSE_CLEANUP_INSPECT_FAILED");
  }
}

export async function inspectComposeOwnership({ identity, marker, composeFile, runDocker }) {
  assertIdentity(identity);
  assertComposeFile(composeFile);
  assertOwnershipMarker(marker, identity);
  if (typeof runDocker !== "function") fail("LOCAL_PILOT_COMPOSE_INSPECT_FAILED");
  const prefix = ["compose", "--project-name", identity.composeProject, "--file", composeFile];
  try {
    const resources = [];
    for (const service of ["postgres", "mailpit"]) {
      const id = boundedOutput(
        await runDocker([...prefix, "ps", "--quiet", service]),
        "LOCAL_PILOT_COMPOSE_INSPECT_FAILED",
      );
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail("LOCAL_PILOT_COMPOSE_INSPECT_FAILED");
      resources.push({
        kind: "container",
        name: service,
        labels: parseLabels(await runDocker([
          "inspect", "--type", "container", "--format", "{{json .Config.Labels}}", id,
        ])),
      });
    }
    resources.push({
      kind: "volume",
      name: "pilot_postgres_data",
      labels: parseLabels(await runDocker([
        "volume", "inspect", "--format", "{{json .Labels}}",
        `${identity.composeProject}_pilot_postgres_data`,
      ])),
    });
    resources.push({
      kind: "network",
      name: "default",
      labels: parseLabels(await runDocker([
        "network", "inspect", "--format", "{{json .Labels}}",
        `${identity.composeProject}_default`,
      ])),
    });
    return verifyComposeResourceLabels(resources, identity, marker);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("LOCAL_PILOT_COMPOSE_OWNERSHIP")) throw error;
    fail("LOCAL_PILOT_COMPOSE_INSPECT_FAILED");
  }
}
