/**
 * Where an SNA edge touches a node, decided in final screen pixels.
 *
 * The reason this is not a layout-space calculation with a scale applied
 * afterwards: the guarantee that matters is about what a person can see. Two
 * arrows between the same pair of students have to be far enough apart on the
 * screen to be told apart, and "far enough" is a number of pixels, not a
 * number of layout units. A separation that holds at 1.5× fails at 0.72×, and
 * the mobile viewport is exactly where it matters most.
 *
 * So every port, fan point and separation check happens after the transform,
 * and the inverse transform is applied only at the end, solely to write the
 * SVG `d` attribute.
 *
 * When a node genuinely cannot hold its incident edges at the minimum
 * separation, this throws `SNA_PORT_CAPACITY` rather than clamping ports on
 * top of each other. A clamped port is a picture that says two students
 * interacted once when they interacted twice; refusing and reflowing is the
 * only answer that keeps the drawing honest.
 */

/** The subset of `DOMMatrix` this module needs; a DOMMatrix satisfies it. */
export interface ScreenMatrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export interface SnaLayoutNode {
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
  readonly rx: number;
  readonly ry: number;
}

export interface SnaEdgeInput {
  readonly edgeId: string;
  readonly source: string;
  readonly target: string;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface AllocatedEdge {
  readonly edgeId: string;
  readonly source: string;
  readonly target: string;
  readonly sourcePortId: string;
  readonly targetPortId: string;
  readonly markerEndId: string;
  readonly screen: {
    readonly sourcePort: ScreenPoint;
    readonly sourceFan: ScreenPoint;
    readonly targetFan: ScreenPoint;
    readonly targetPort: ScreenPoint;
  };
  /** Cubic path in layout space, for the SVG `d` attribute. */
  readonly path: string;
}

export class SnaPortCapacityError extends Error {
  constructor(readonly nodeId: string) { super("SNA_PORT_CAPACITY"); }
}

/** Minimum distance between any two ports on one node, in final screen pixels. */
export const MIN_PORT_SEPARATION_PX = 8;
/** How far a curve leaves the node before it heads for the other end. */
export const FAN_LENGTH_PX = 12;
/**
 * Distance between the tracks of a reciprocal pair, in screen pixels.
 *
 * Larger than the eight-pixel floor on purpose. A cubic's midpoint sits at
 * `(P0 + 3P1 + 3P2 + P3) / 8`, so the fan control points contribute only
 * three quarters of their offset to the middle of the curve — the place two
 * arcs are most likely to converge. Twenty pixels of track keeps the whole
 * curve clear of its partner, not just its endpoints.
 */
export const TRACK_SEPARATION_PX = 20;

const IDENTITY: ScreenMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const TWO_PI = Math.PI * 2;

function applyMatrix(matrix: ScreenMatrix, x: number, y: number): ScreenPoint {
  return { x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f };
}

function invert(matrix: ScreenMatrix): ScreenMatrix {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || determinant === 0) throw new Error("SNA_MATRIX_SINGULAR");
  return {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant,
  };
}

interface ScreenNode {
  readonly nodeId: string;
  readonly centre: ScreenPoint;
  readonly rx: number;
  readonly ry: number;
}

function toScreenNode(node: SnaLayoutNode, matrix: ScreenMatrix): ScreenNode {
  // An affine transform maps an ellipse to an ellipse; the axis lengths scale
  // by the column norms, which is exact for the scale-and-translate matrices a
  // viewBox produces.
  return {
    nodeId: node.nodeId,
    centre: applyMatrix(matrix, node.x, node.y),
    rx: Math.abs(node.rx) * Math.hypot(matrix.a, matrix.b),
    ry: Math.abs(node.ry) * Math.hypot(matrix.c, matrix.d),
  };
}

function boundaryPoint(node: ScreenNode, angle: number): ScreenPoint {
  return { x: node.centre.x + node.rx * Math.cos(angle), y: node.centre.y + node.ry * Math.sin(angle) };
}

/** Outward unit normal of the ellipse at the given parameter angle. */
function outward(node: ScreenNode, angle: number): ScreenPoint {
  const nx = Math.cos(angle) / Math.max(node.rx, 1e-9);
  const ny = Math.sin(angle) / Math.max(node.ry, 1e-9);
  const length = Math.hypot(nx, ny) || 1;
  return { x: nx / length, y: ny / length };
}

export function screenDistance(a: ScreenPoint, b: ScreenPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * The smallest angular gap that keeps two boundary points at least
 * `MIN_PORT_SEPARATION_PX` apart.
 *
 * The chord between two points at angular distance d is at least
 * `2 * rMin * sin(d / 2)`, so requiring that to exceed the minimum gives the
 * bound below. Using the smaller semi-axis makes it conservative, which is the
 * right direction to be wrong in.
 */
function minimumAngularGap(node: ScreenNode): number {
  const smallest = Math.min(node.rx, node.ry);
  if (smallest <= 0) return Number.POSITIVE_INFINITY;
  // A hair above the floor, so a port placed exactly at the minimum does not
  // land a few float-ulps below it. The contract is "at least eight pixels",
  // and 7.999999999999996 does not satisfy it.
  const ratio = (MIN_PORT_SEPARATION_PX + 1e-6) / (2 * smallest);
  if (ratio >= 1) return Number.POSITIVE_INFINITY;
  return 2 * Math.asin(ratio);
}

interface Endpoint {
  readonly portId: string;
  readonly edgeIndex: number;
  readonly role: "source" | "target";
  readonly preferred: number;
  readonly trackOffset: number;
}

function normalise(angle: number): number {
  const value = angle % TWO_PI;
  return value < 0 ? value + TWO_PI : value;
}

/**
 * Place every port on one node, or say the node cannot hold them.
 *
 * Ports keep their preferred direction when there is room, and are pushed
 * apart in order when there is not. If even an equal spread cannot satisfy the
 * minimum, the node is over capacity and the caller has to reflow.
 */
function placePorts(node: ScreenNode, endpoints: readonly Endpoint[]): Map<string, number> {
  const gap = minimumAngularGap(node);
  if (endpoints.length * gap > TWO_PI + 1e-9) throw new SnaPortCapacityError(node.nodeId);

  const ordered = [...endpoints].sort((left, right) =>
    left.preferred - right.preferred || left.portId.localeCompare(right.portId));

  const angles: number[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const endpoint of ordered) {
    const angle = angles.length === 0 ? endpoint.preferred : Math.max(endpoint.preferred, previous + gap);
    angles.push(angle);
    previous = angle;
  }
  // The wrap-around gap is the one a forward pass cannot see. When it closes
  // too tightly, an equal spread anchored at the first preferred angle is the
  // deterministic fallback, and it always satisfies the minimum once the
  // capacity check above has passed.
  const wrap = angles[0]! + TWO_PI - angles[angles.length - 1]!;
  const placed = wrap >= gap - 1e-9
    ? angles
    : ordered.map((_endpoint, index) => ordered[0]!.preferred + (index * TWO_PI) / ordered.length);

  const byPort = new Map<string, number>();
  ordered.forEach((endpoint, index) => byPort.set(endpoint.portId, normalise(placed[index]!)));

  // Verified rather than assumed: the bound above is conservative, so this
  // should never fire, and if it ever does the drawing must not be produced.
  const points = ordered.map((endpoint) => boundaryPoint(node, byPort.get(endpoint.portId)!));
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      if (screenDistance(points[left]!, points[right]!) < MIN_PORT_SEPARATION_PX - 1e-6) {
        throw new SnaPortCapacityError(node.nodeId);
      }
    }
  }
  return byPort;
}

function pairKey(edge: SnaEdgeInput): string {
  return [edge.source, edge.target].sort().join(" ");
}

/**
 * Allocate every edge's ports, fan points and path in final screen pixels.
 *
 * Throws `SnaPortCapacityError` (message `SNA_PORT_CAPACITY`) before creating
 * any path when a node cannot hold its edges.
 */
export function allocateScreenEdges(
  nodes: readonly SnaLayoutNode[],
  edges: readonly SnaEdgeInput[],
  matrix: ScreenMatrix = IDENTITY,
): AllocatedEdge[] {
  // The bow is widened per pair until the curves are provably clear of each
  // other, rather than set to a constant that happens to work at one zoom.
  // A cubic's midpoint takes only three quarters of its control points'
  // offset, and how much room the curve has depends on how far apart the nodes
  // are on screen — which is exactly what changes between desktop and mobile.
  const widths = new Map<string, number>();
  for (let round = 0; round < 8; round += 1) {
    const allocated = allocateWithWidths(nodes, edges, matrix, widths);
    const crowded = firstCrowdedPair(allocated);
    if (!crowded) return allocated;
    widths.set(crowded, (widths.get(crowded) ?? TRACK_SEPARATION_PX) * 1.6);
  }
  throw new Error("SNA_TRACK_SEPARATION_UNRESOLVED");
}

/**
 * The unordered pair whose curves come closer than the floor, if any.
 *
 * Sampling is what decides it. Two arcs can leave and arrive far apart and
 * still meet in the middle, so the endpoints alone do not answer the question
 * the reader is actually asking.
 */
function firstCrowdedPair(allocated: readonly AllocatedEdge[]): string | undefined {
  const groups = new Map<string, AllocatedEdge[]>();
  for (const edge of allocated) {
    if (edge.source === edge.target) continue;
    const key = [edge.source, edge.target].sort().join(" ");
    groups.set(key, [...(groups.get(key) ?? []), edge]);
  }
  for (const [key, group] of groups) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const a = group[left]!;
        const b = group[right]!;
        // Opposed edges are compared head-to-tail; parallel ones head-to-head.
        const opposed = a.source === b.target && a.target === b.source;
        for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
          const other = opposed ? 1 - t : t;
          if (screenDistance(sampleScreenPath(a, t), sampleScreenPath(b, other)) < MIN_PORT_SEPARATION_PX) {
            return key;
          }
        }
      }
    }
  }
  return undefined;
}

function allocateWithWidths(
  nodes: readonly SnaLayoutNode[],
  edges: readonly SnaEdgeInput[],
  matrix: ScreenMatrix,
  widths: ReadonlyMap<string, number>,
): AllocatedEdge[] {
  const screenNodes = new Map(nodes.map((node) => [node.nodeId, toScreenNode(node, matrix)]));
  for (const edge of edges) {
    if (!screenNodes.has(edge.source) || !screenNodes.has(edge.target)) throw new Error("SNA_EDGE_ENDPOINT_UNKNOWN");
  }

  // Edges between the same unordered pair share one normal, computed from the
  // lexically ordered pair, so reversing direction cannot land two edges on
  // the same curve.
  const tracks = new Map<string, number>();
  const trackIndex = edges.map((edge) => {
    const key = pairKey(edge);
    const index = tracks.get(key) ?? 0;
    tracks.set(key, index + 1);
    return index;
  });
  const trackCount = new Map(tracks);

  const endpointsByNode = new Map<string, Endpoint[]>();
  const push = (nodeId: string, endpoint: Endpoint): void => {
    const list = endpointsByNode.get(nodeId) ?? [];
    list.push(endpoint);
    endpointsByNode.set(nodeId, list);
  };

  edges.forEach((edge, index) => {
    const source = screenNodes.get(edge.source)!;
    const target = screenNodes.get(edge.target)!;
    const total = trackCount.get(pairKey(edge)) ?? 1;
    // Tracks are centred on the straight line, so a single edge is straight
    // and a reciprocal pair sits symmetrically either side of it.
    // The port shift stays on the constant. Widening it too would rotate the
    // ports around the node as the bow grows, eventually swapping which side
    // each curve leaves from and undoing the separation the bow just bought.
    const offset = (trackIndex[index]! - (total - 1) / 2) * TRACK_SEPARATION_PX;
    if (edge.source === edge.target) {
      // A self-loop leaves and returns at two distinct angles, rotated per
      // loop so repeated loops on one node stay separate curves.
      const base = (trackIndex[index]! * TWO_PI) / Math.max(total, 1);
      const spread = Math.PI / 8;
      push(edge.source, {
        portId: `${edge.edgeId}:source`, edgeIndex: index, role: "source",
        preferred: normalise(base - spread), trackOffset: offset,
      });
      push(edge.target, {
        portId: `${edge.edgeId}:target`, edgeIndex: index, role: "target",
        preferred: normalise(base + spread), trackOffset: offset,
      });
      return;
    }
    // Both ends of one edge are pushed to the *same* side of the line between
    // the nodes, using the pair's shared normal. Pushing them to opposite
    // sides — which is what taking each port's own displacement does — twists
    // the curve instead of bowing it, and a twist leaves the middle of the
    // curve exactly where its partner's middle is.
    const span = Math.max(screenDistance(source.centre, target.centre), 1);
    const dirX = (target.centre.x - source.centre.x) / span;
    const dirY = (target.centre.y - source.centre.y) / span;
    const [firstId] = [edge.source, edge.target].sort();
    const orientation = firstId === edge.source ? 1 : -1;
    const nX = -dirY * orientation;
    const nY = dirX * orientation;
    const k = total > 1 ? offset / Math.max(Math.max(source.rx, source.ry), 1) : 0;
    push(edge.source, {
      portId: `${edge.edgeId}:source`, edgeIndex: index, role: "source",
      preferred: normalise(Math.atan2(dirY + k * nY, dirX + k * nX)), trackOffset: offset,
    });
    push(edge.target, {
      portId: `${edge.edgeId}:target`, edgeIndex: index, role: "target",
      preferred: normalise(Math.atan2(-dirY + k * nY, -dirX + k * nX)), trackOffset: offset,
    });
  });

  const angles = new Map<string, number>();
  for (const [nodeId, endpoints] of endpointsByNode) {
    const node = screenNodes.get(nodeId)!;
    for (const [portId, angle] of placePorts(node, endpoints)) angles.set(portId, angle);
  }

  const inverse = invert(matrix);
  const toLayout = (point: ScreenPoint): ScreenPoint => applyMatrix(inverse, point.x, point.y);
  const round = (value: number): string => (Math.round(value * 1000) / 1000).toString();

  return edges.map((edge, index) => {
    const source = screenNodes.get(edge.source)!;
    const target = screenNodes.get(edge.target)!;
    const sourcePortId = `${edge.edgeId}:source`;
    const targetPortId = `${edge.edgeId}:target`;
    const sourceAngle = angles.get(sourcePortId)!;
    const targetAngle = angles.get(targetPortId)!;
    const sourcePort = boundaryPoint(source, sourceAngle);
    const targetPort = boundaryPoint(target, targetAngle);
    const total = trackCount.get(pairKey(edge)) ?? 1;
    const width = widths.get(pairKey(edge)) ?? TRACK_SEPARATION_PX;
    const offset = (trackIndex[index]! - (total - 1) / 2) * width;

    const isSelf = edge.source === edge.target;
    // The fan leaves along the boundary normal, then the whole curve is pushed
    // along the pair's shared normal by this edge's track offset. A self-loop
    // fans further out per loop so its curves stay distinct.
    const selfReach = FAN_LENGTH_PX * (2 + trackIndex[index]!);
    const sourceOut = outward(source, sourceAngle);
    const targetOut = outward(target, targetAngle);
    const reach = isSelf ? selfReach : FAN_LENGTH_PX;

    let normalX = 0;
    let normalY = 0;
    if (!isSelf && offset !== 0) {
      const [first, second] = [edge.source, edge.target].sort();
      const a = screenNodes.get(first!)!.centre;
      const b = screenNodes.get(second!)!.centre;
      const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      normalX = -(b.y - a.y) / length;
      normalY = (b.x - a.x) / length;
    }

    // The fan bows further onto the side its own port already sits, rather
    // than by a per-edge sign. Taking the sign from the port is what keeps a
    // reciprocal pair curving away from each other: a fixed per-edge sign can
    // push both fans back across the centre line and make two curves that
    // started apart meet in the middle.
    const bow = Math.sign(offset) * Math.abs(offset);
    const sourceFan: ScreenPoint = {
      x: sourcePort.x + sourceOut.x * reach + normalX * bow,
      y: sourcePort.y + sourceOut.y * reach + normalY * bow,
    };
    const targetFan: ScreenPoint = {
      x: targetPort.x + targetOut.x * reach + normalX * bow,
      y: targetPort.y + targetOut.y * reach + normalY * bow,
    };

    const layout = [sourcePort, sourceFan, targetFan, targetPort].map(toLayout);
    const path = `M ${round(layout[0]!.x)} ${round(layout[0]!.y)}`
      + ` C ${round(layout[1]!.x)} ${round(layout[1]!.y)},`
      + ` ${round(layout[2]!.x)} ${round(layout[2]!.y)},`
      + ` ${round(layout[3]!.x)} ${round(layout[3]!.y)}`;

    return {
      edgeId: edge.edgeId,
      source: edge.source,
      target: edge.target,
      sourcePortId,
      targetPortId,
      markerEndId: `arrow-${edge.edgeId}`,
      screen: { sourcePort, sourceFan, targetFan, targetPort },
      path,
    };
  });
}

/** Sample an allocated edge's screen-space curve at `t` in [0, 1]. */
export function sampleScreenPath(edge: AllocatedEdge, t: number): ScreenPoint {
  const { sourcePort, sourceFan, targetFan, targetPort } = edge.screen;
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * sourcePort.x + w1 * sourceFan.x + w2 * targetFan.x + w3 * targetPort.x,
    y: w0 * sourcePort.y + w1 * sourceFan.y + w2 * targetFan.y + w3 * targetPort.y,
  };
}

export interface FittedLayout {
  readonly nodes: readonly SnaLayoutNode[];
  readonly screenCtm: ScreenMatrix;
}

/**
 * Enlarge the nodes that cannot hold their edges, and leave the rest alone.
 *
 * Growing only the crowded nodes keeps the rest of the picture where the
 * reader last saw it: a reflow that moved everything would look like the data
 * changed when only the drawing did.
 */
export function fitNodesForPortCapacity(
  nodes: readonly SnaLayoutNode[],
  edges: readonly SnaEdgeInput[],
  matrix: ScreenMatrix = IDENTITY,
  { maxRounds = 12, growth = 1.35 }: { maxRounds?: number; growth?: number } = {},
): FittedLayout {
  let current = nodes.map((node) => ({ ...node }));
  for (let round = 0; round < maxRounds; round += 1) {
    try {
      allocateScreenEdges(current, edges, matrix);
      return { nodes: current, screenCtm: matrix };
    } catch (error) {
      if (!(error instanceof SnaPortCapacityError)) throw error;
      const crowded = error.nodeId;
      current = current.map((node) => (node.nodeId === crowded
        ? { ...node, rx: node.rx * growth, ry: node.ry * growth }
        : node));
    }
  }
  throw new Error("SNA_PORT_CAPACITY_UNRESOLVED");
}

/** Every port on every node, for assertions and for rendering handles. */
export function incidentPorts(allocated: readonly AllocatedEdge[]): Map<string, ScreenPoint[]> {
  const byNode = new Map<string, ScreenPoint[]>();
  for (const edge of allocated) {
    for (const [nodeId, point] of [
      [edge.source, edge.screen.sourcePort] as const,
      [edge.target, edge.screen.targetPort] as const,
    ]) {
      const list = byNode.get(nodeId) ?? [];
      list.push(point);
      byNode.set(nodeId, list);
    }
  }
  return byNode;
}
