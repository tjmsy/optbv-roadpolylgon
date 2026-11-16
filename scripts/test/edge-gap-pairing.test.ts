import assert from "node:assert/strict";
import { test } from "node:test";
import { nearestBridgePartner } from "../../src/core/edge-gap-pairing.js";
import { DEFAULT_EDGE_GAP_OPTIONS } from "../../src/core/edge-gap-config.js";
import { PointGridIndex } from "../../src/core/spatial-index.js";

test("nearest bridge search includes endpoints within the meter cap at high latitude", () => {
  const latitude = 70;
  const longitudeOffset =
    900 / (111_320 * Math.cos((latitude * Math.PI) / 180));
  const endpoint = {
    edgeIndex: 0,
    end: "a" as const,
    coord: [0, latitude] as [number, number],
    inwardBearing: 90,
  };
  const partner = {
    edgeIndex: 1,
    end: "a" as const,
    coord: [longitudeOffset, latitude] as [number, number],
    inwardBearing: -90,
  };
  const candidates = [endpoint, partner];
  const index = new PointGridIndex<typeof endpoint>(0.005);
  for (const candidate of candidates) {
    index.insert(candidate.coord[0], candidate.coord[1], candidate);
  }
  const options = {
    ...DEFAULT_EDGE_GAP_OPTIONS,
    maxBridgeM: 1_000,
    maxBridgeMidRoadM: 1_000,
  };

  const result = nearestBridgePartner(
    endpoint,
    candidates,
    [],
    () => ({ cl: null, kind: "topology", angleToClDeg: null }),
    options,
    index
  );

  assert.equal(result?.other, partner);
  assert.ok(result && result.distM <= options.maxBridgeM);
});
