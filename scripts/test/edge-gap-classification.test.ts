import assert from "node:assert/strict";
import { test } from "node:test";
import { lineString } from "@turf/helpers";
import { classifyEdgeGap, centerlineContext } from "../../src/core/edge-gap-classification.js";
import { DEFAULT_EDGE_GAP_OPTIONS } from "../../src/core/edge-gap-config.js";
import { nearestBridgePartner } from "../../src/core/edge-gap-pairing.js";
import { shouldBridgeKind } from "../../src/core/edge-gap-endpoints.js";
import type { LineFeature } from "../../src/core/types.js";

test("unrelated nearby centerline endpoint does not misclassify a mid-road gap", () => {
  const mainRoad = lineString(
    [
      [-0.01, 0],
      [0.01, 0],
    ],
    {}
  ) as LineFeature;
  const unrelatedShortLine = lineString(
    [
      [0.00005, 0.00005],
      [0.00005, 0.0001],
    ],
    {}
  ) as LineFeature;
  const context = centerlineContext(0, 0, [mainRoad, unrelatedShortLine]);

  assert.ok(context);
  assert.ok(context.distToLineM < 0.01);
  assert.ok(context.distToEndpointM > 1_000);

  const classification = classifyEdgeGap(0, context, {
    ...DEFAULT_EDGE_GAP_OPTIONS,
    clHintM: 80,
    clNearM: 15,
    clEndpointNearM: 8,
  });
  assert.equal(classification.kind, "topology");
});

test("dead-end classification respects the configured perpendicular threshold", () => {
  const context = {
    distToLineM: 5,
    segmentBearing: 0,
    distToEndpointM: 5,
  };
  const options = {
    ...DEFAULT_EDGE_GAP_OPTIONS,
    parallelMaxDeg: 45,
    perpendicularMinDeg: 55,
  };

  assert.equal(classifyEdgeGap(50, context, options).kind, "topology");
  assert.equal(classifyEdgeGap(60, context, options).kind, "dead-end");
});

test("disabling mid-road bridging leaves other bridge kinds enabled", () => {
  assert.equal(shouldBridgeKind("mid-road", false), false);
  assert.equal(shouldBridgeKind("dead-end", false), true);
  assert.equal(shouldBridgeKind("topology", false), true);
});

test("disabled nearer mid-road candidate does not hide a valid topology pair", () => {
  const start = {
    edgeIndex: 0,
    end: "a" as const,
    coord: [0, 0] as [number, number],
    inwardBearing: 0,
  };
  const nearerMidRoad = {
    edgeIndex: 1,
    end: "a" as const,
    coord: [0.00005, 0] as [number, number],
    inwardBearing: 180,
  };
  const fartherTopology = {
    edgeIndex: 2,
    end: "a" as const,
    coord: [0.0001, 0] as [number, number],
    inwardBearing: 180,
  };
  const options = {
    ...DEFAULT_EDGE_GAP_OPTIONS,
    bridgeMidRoad: false,
  };

  const result = nearestBridgePartner(
    start,
    [start, nearerMidRoad, fartherTopology],
    [],
    (_a, b) => ({
      cl: null,
      kind: b === nearerMidRoad ? "mid-road" : "topology",
      angleToClDeg: null,
    }),
    options
  );

  assert.equal(result?.other, fartherTopology);
});
