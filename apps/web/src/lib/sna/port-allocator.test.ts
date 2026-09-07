import { describe, expect, it } from "vitest";

import {
  allocateScreenEdges,
  fitNodesForPortCapacity,
  incidentPorts,
  MIN_PORT_SEPARATION_PX,
  sampleScreenPath,
  screenDistance,
  SnaPortCapacityError,
  type ScreenMatrix,
  type SnaEdgeInput,
  type SnaLayoutNode,
} from "./port-allocator.js";

const ACTOR_A = "actor-a";
const ACTOR_B = "actor-b";
const ACTOR_C = "actor-c";

const DESKTOP: ScreenMatrix = { a: 1.5, b: 0, c: 0, d: 1.5, e: 24, f: 18 };
const MOBILE: ScreenMatrix = { a: 0.72, b: 0, c: 0, d: 0.72, e: 8, f: 12 };
const IDENTITY: ScreenMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function node(nodeId: string, x: number, y: number, radius = 24): SnaLayoutNode {
  return { nodeId, x, y, rx: radius, ry: radius };
}

const nodes = [node(ACTOR_A, 100, 100), node(ACTOR_B, 300, 140), node(ACTOR_C, 200, 320)];

function edge(source: string, target: string, edgeId = `${source}->${target}`): SnaEdgeInput {
  return { edgeId, source, target };
}

/** Every pair of ports on one node, checked against the pixel floor. */
function assertEveryIncidentPortPairAtLeast(allocated: ReturnType<typeof allocateScreenEdges>, minimum: number): void {
  for (const [, points] of incidentPorts(allocated)) {
    for (let left = 0; left < points.length; left += 1) {
      for (let right = left + 1; right < points.length; right += 1) {
        expect(screenDistance(points[left]!, points[right]!)).toBeGreaterThanOrEqual(minimum - 1e-6);
      }
    }
  }
}

/** Every port sits on the boundary of the node it belongs to. */
function assertEveryPortOnItsConnectionBoundary(
  allocated: ReturnType<typeof allocateScreenEdges>,
  layout: readonly SnaLayoutNode[],
  matrix: ScreenMatrix,
  tolerance: number,
): void {
  const scaleX = Math.hypot(matrix.a, matrix.b);
  const scaleY = Math.hypot(matrix.c, matrix.d);
  const byId = new Map(layout.map((item) => [item.nodeId, item]));
  for (const allocation of allocated) {
    for (const [nodeId, port] of [
      [allocation.source, allocation.screen.sourcePort] as const,
      [allocation.target, allocation.screen.targetPort] as const,
    ]) {
      const item = byId.get(nodeId)!;
      const centreX = matrix.a * item.x + matrix.c * item.y + matrix.e;
      const centreY = matrix.b * item.x + matrix.d * item.y + matrix.f;
      const rx = item.rx * scaleX;
      const ry = item.ry * scaleY;
      const value = ((port.x - centreX) / rx) ** 2 + ((port.y - centreY) / ry) ** 2;
      expect(Math.abs(value - 1)).toBeLessThanOrEqual(tolerance);
    }
  }
}

describe("screen-pixel port geometry", () => {
  it.each([["desktop", DESKTOP], ["mobile", MOBILE]] as const)(
    "keeps a reciprocal pair at least eight final screen pixels apart on %s",
    (_name, matrix) => {
      const [forward, reverse] = allocateScreenEdges(
        nodes, [edge(ACTOR_A, ACTOR_B), edge(ACTOR_B, ACTOR_A)], matrix,
      );

      // The pixel floor is what a person can actually tell apart, so it is
      // checked after the transform, not before it.
      expect(screenDistance(forward!.screen.sourcePort, reverse!.screen.targetPort)).toBeGreaterThanOrEqual(8);
      expect(screenDistance(forward!.screen.targetPort, reverse!.screen.sourcePort)).toBeGreaterThanOrEqual(8);
      expect(screenDistance(forward!.screen.sourceFan, reverse!.screen.targetFan)).toBeGreaterThanOrEqual(8);
      expect(screenDistance(forward!.screen.targetFan, reverse!.screen.sourceFan)).toBeGreaterThanOrEqual(8);

      expect(forward!.path).not.toBe(reverse!.path);
      expect(forward!.markerEndId).not.toBe(reverse!.markerEndId);
      expect(forward!.sourcePortId).not.toBe(reverse!.targetPortId);

      // Sampling the curves proves the whole path stays apart, not only its
      // endpoints: two arcs can start and end far apart and still cross.
      for (const t of [0.25, 0.5, 0.75]) {
        expect(screenDistance(sampleScreenPath(forward!, t), sampleScreenPath(reverse!, 1 - t)))
          .toBeGreaterThanOrEqual(8);
      }
    },
  );

  it("draws a single edge straight, with no track offset to justify", () => {
    const [only] = allocateScreenEdges(nodes, [edge(ACTOR_A, ACTOR_B)], DESKTOP);
    const midpoint = sampleScreenPath(only!, 0.5);
    const straight = {
      x: (only!.screen.sourcePort.x + only!.screen.targetPort.x) / 2,
      y: (only!.screen.sourcePort.y + only!.screen.targetPort.y) / 2,
    };
    expect(screenDistance(midpoint, straight)).toBeLessThan(1);
  });

  it("gives every self-loop on one node a distinct path and distinct ports", () => {
    const loops = allocateScreenEdges(
      nodes,
      ["self-1", "self-2", "self-3"].map((edgeId) => edge(ACTOR_A, ACTOR_A, edgeId)),
      IDENTITY,
    );
    expect(new Set(loops.map((loop) => loop.path)).size).toBe(3);
    for (const loop of loops) {
      expect(loop.path).not.toMatch(/NaN|Infinity/);
      expect(loop.sourcePortId).not.toBe(loop.targetPortId);
      expect(loop.path).toContain(" C ");
    }
    assertEveryIncidentPortPairAtLeast(loops, MIN_PORT_SEPARATION_PX);
  });

  it("refuses before clamping when a node cannot hold its loops, then reflows", () => {
    const dense = Array.from({ length: 6 }, (_value, index) => edge(ACTOR_A, ACTOR_A, `dense-${index}`));
    const tight: ScreenMatrix = { a: 0.15, b: 0, c: 0, d: 0.15, e: 0, f: 0 };

    // A clamped port would draw two interactions as one. Refusing is the only
    // answer that keeps the picture honest.
    expect(() => allocateScreenEdges(nodes, dense, tight)).toThrow("SNA_PORT_CAPACITY");

    const fitted = fitNodesForPortCapacity(nodes, dense, tight);
    const loops = allocateScreenEdges(fitted.nodes, dense, fitted.screenCtm);
    expect(new Set(loops.map((loop) => loop.path)).size).toBe(dense.length);
    assertEveryIncidentPortPairAtLeast(loops, MIN_PORT_SEPARATION_PX);
  });

  it.each([["desktop", DESKTOP], ["mobile", MOBILE]] as const)(
    "reflows a dense star onto real connection boundaries on %s",
    (_name, matrix) => {
      const spokes = Array.from({ length: 14 }, (_value, index) => node(`spoke-${index}`,
        200 + 160 * Math.cos((index * Math.PI * 2) / 14),
        200 + 160 * Math.sin((index * Math.PI * 2) / 14), 10));
      const layout = [node(ACTOR_A, 200, 200, 10), ...spokes];
      const edges = spokes.map((spoke, index) => edge(ACTOR_A, spoke.nodeId, `spoke-edge-${index}`));

      const fitted = fitNodesForPortCapacity(layout, edges, matrix);
      const allocated = allocateScreenEdges(fitted.nodes, edges, fitted.screenCtm);
      assertEveryIncidentPortPairAtLeast(allocated, MIN_PORT_SEPARATION_PX);
      assertEveryPortOnItsConnectionBoundary(allocated, fitted.nodes, fitted.screenCtm, 0.001);
    },
  );

  it("puts self-loops, reciprocals and a star through one solver", () => {
    const layout = [node(ACTOR_A, 120, 120, 18), node(ACTOR_B, 320, 160, 18), node(ACTOR_C, 220, 340, 18)];
    const edges = [
      edge(ACTOR_A, ACTOR_A, "self-a1"),
      edge(ACTOR_A, ACTOR_A, "self-a2"),
      edge(ACTOR_A, ACTOR_B, "ab"),
      edge(ACTOR_B, ACTOR_A, "ba"),
      edge(ACTOR_A, ACTOR_C, "ac"),
      edge(ACTOR_C, ACTOR_A, "ca"),
      edge(ACTOR_B, ACTOR_C, "bc"),
    ];
    const fitted = fitNodesForPortCapacity(layout, edges, DESKTOP);
    const allocated = allocateScreenEdges(fitted.nodes, edges, fitted.screenCtm);
    assertEveryIncidentPortPairAtLeast(allocated, MIN_PORT_SEPARATION_PX);
    assertEveryPortOnItsConnectionBoundary(allocated, fitted.nodes, fitted.screenCtm, 0.001);
    expect(new Set(allocated.map((item) => item.path)).size).toBe(allocated.length);
  });

  it("does not move the nodes that were never crowded", () => {
    const dense = Array.from({ length: 6 }, (_value, index) => edge(ACTOR_A, ACTOR_A, `dense-${index}`));
    const fitted = fitNodesForPortCapacity(nodes, dense, { a: 0.15, b: 0, c: 0, d: 0.15, e: 0, f: 0 });
    const untouched = fitted.nodes.find((item) => item.nodeId === ACTOR_C)!;
    // A reflow that moved everything would look like the data changed when
    // only the drawing did.
    expect(untouched).toEqual(nodes[2]);
  });

  it("produces the same geometry for the same input every time", () => {
    const edges = [edge(ACTOR_A, ACTOR_B), edge(ACTOR_B, ACTOR_A), edge(ACTOR_A, ACTOR_C)];
    const first = allocateScreenEdges(nodes, edges, DESKTOP);
    const second = allocateScreenEdges(nodes, edges, DESKTOP);
    expect(second.map((item) => item.path)).toEqual(first.map((item) => item.path));
  });

  it("writes the path in layout space so the transform is applied once", () => {
    const [only] = allocateScreenEdges(nodes, [edge(ACTOR_A, ACTOR_B)], DESKTOP);
    const start = /^M (-?[\d.]+) (-?[\d.]+)/.exec(only!.path)!;
    const layoutX = Number(start[1]);
    const layoutY = Number(start[2]);
    // Transforming the written point forward must land on the screen port.
    expect(DESKTOP.a * layoutX + DESKTOP.e).toBeCloseTo(only!.screen.sourcePort.x, 2);
    expect(DESKTOP.d * layoutY + DESKTOP.f).toBeCloseTo(only!.screen.sourcePort.y, 2);
  });

  it("refuses an edge naming a node that is not in the layout", () => {
    expect(() => allocateScreenEdges(nodes, [edge(ACTOR_A, "ghost")], IDENTITY))
      .toThrow("SNA_EDGE_ENDPOINT_UNKNOWN");
  });

  it("names the crowded node on a capacity failure", () => {
    const dense = Array.from({ length: 8 }, (_value, index) => edge(ACTOR_A, ACTOR_A, `dense-${index}`));
    try {
      allocateScreenEdges(nodes, dense, { a: 0.1, b: 0, c: 0, d: 0.1, e: 0, f: 0 });
      throw new Error("expected a capacity failure");
    } catch (error) {
      expect(error).toBeInstanceOf(SnaPortCapacityError);
      expect((error as SnaPortCapacityError).nodeId).toBe(ACTOR_A);
    }
  });
});
