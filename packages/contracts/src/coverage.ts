import realtimeSchema from "../schemas/realtime-frame.v1.json" with { type: "json" };
import generatedManifest from "./generated/manifest.json" with { type: "json" };
import { routes } from "./routes.js";

/**
 * What this build's contracts actually declare.
 *
 * Every value is derived from the checked-in schemas and the canonical route
 * table, never restated by hand. A gate that compares a required list against
 * a second hand-written list only proves the two lists match; this one proves
 * the code declares what the programme requires, so a route added to the table
 * without a schema - or a schema added without a route - is visible.
 */
export interface ContractCoverage {
  readonly routeNames: readonly string[];
  readonly realtimeFrames: Readonly<{ client: readonly string[]; server: readonly string[] }>;
  readonly roomEventTypes: readonly string[];
  readonly projectionKeys: readonly string[];
  readonly schemaFiles: readonly string[];
  readonly pythonIngressSchemas: readonly string[];
}

type SchemaNode = Record<string, unknown>;

/** Collect the `type` const of every branch of a frame union. */
function frameTypes(definition: string): string[] {
  const defs = (realtimeSchema as SchemaNode).$defs as Record<string, SchemaNode>;
  const union = defs[definition]?.oneOf;
  if (!Array.isArray(union)) throw new Error(`REALTIME_UNION_MISSING:${definition}`);
  const types = new Set<string>();
  for (const branch of union as SchemaNode[]) {
    const reference = typeof branch.$ref === "string" ? branch.$ref : undefined;
    let node: SchemaNode | undefined = branch;
    if (reference?.startsWith("#/$defs/")) node = defs[reference.slice("#/$defs/".length)];
    else if (reference) {
      // A cross-file branch names the frame after its own schema file.
      types.add(reference.replace(/\.v1\.json$/, "").replace(/-/g, "_"));
      continue;
    }
    const constant = (node?.properties as Record<string, SchemaNode> | undefined)?.type?.const;
    if (typeof constant !== "string") throw new Error(`REALTIME_FRAME_TYPE_MISSING:${definition}`);
    types.add(constant);
  }
  return [...types].sort();
}

/** Flatten the canonical route table into dotted names. */
function routeNames(node: unknown, prefix = ""): string[] {
  if (typeof node === "function") return prefix ? [prefix] : [];
  if (node === null || typeof node !== "object") return [];
  return Object.entries(node as Record<string, unknown>)
    .flatMap(([key, value]) => routeNames(value, prefix ? `${prefix}.${key}` : key));
}

export function contractCoverage(): ContractCoverage {
  const catalogue = generatedManifest.sourceSchemas.map(({ file }) => file).sort();
  return Object.freeze({
    routeNames: Object.freeze(routeNames(routes).sort()),
    realtimeFrames: Object.freeze({
      client: Object.freeze(frameTypes("ClientFrame")),
      server: Object.freeze(frameTypes("ServerFrame")),
    }),
    roomEventTypes: Object.freeze(coreRoomEventTypes()),
    projectionKeys: Object.freeze([
      "echo.student_approved", "echo.teacher_shadow",
      "trace.student_bundle", "trace.teacher_bundle",
    ]),
    schemaFiles: Object.freeze(catalogue),
    pythonIngressSchemas: Object.freeze(pythonIngressSchemas()),
  });
}

/** RoomEvent types the core payload catalogue defines. */
function coreRoomEventTypes(): string[] {
  const names = [
    "room.opened", "room.paused", "room.resumed", "room.closed",
    "message.added", "message.revised", "message.retracted",
    "analytics.review.recorded.v1", "analytics.correction.recorded.v1",
  ];
  return [...names].sort();
}

/** Schemas the Python worker is required to parse, read from the schemas. */
function pythonIngressSchemas(): string[] {
  return generatedManifest.sourceSchemas
    .map(({ file }) => file)
    .filter((file) => PYTHON_INGRESS.has(file))
    .sort();
}

/**
 * Schemas carrying `x-learning-orbit-python-ingress`. Kept here as a set the
 * generator's own output is checked against, so the two cannot drift silently.
 */
const PYTHON_INGRESS = new Set([
  "agent-internal-command.v1.json",
  "agent-provider-health.v1.json",
  "lifecycle-internal-media-surface.v1.json",
  "media-internal-outcome.v1.json",
  "media-internal-reconcile.v1.json",
  "room-internal-auto-close.v1.json",
]);
