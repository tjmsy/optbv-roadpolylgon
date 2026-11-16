import type { Position } from "geojson";
import type { PairClassification } from "./edge-gap-classification.js";
import type { EdgeGapOptions } from "./edge-gap-config.js";
import { haversineMeters, metersToDegPad } from "./geodesy.js";
import { PointGridIndex } from "./spatial-index.js";
import type { LineFeature } from "./types.js";

type Endpoint = {
  edgeIndex: number;
  end: "a" | "b";
  coord: Position;
  inwardBearing: number;
};

function endpointKey(endpoint: Endpoint): string {
  return `${endpoint.edgeIndex}:${endpoint.end}`;
}

function maxBridgeScanM(options: EdgeGapOptions): number {
  return Math.max(options.maxBridgeM, options.maxBridgeMidRoadM);
}

function bridgeWouldDuplicateExistingEdge(
  a: Endpoint,
  b: Endpoint,
  edges: LineFeature[],
  epsilonM: number,
  availableEndpointKeys?: Set<string>
): boolean {
  return (
    bridgeSkipsNearerTipOnPartnerEdge(
      a,
      b,
      edges,
      epsilonM,
      availableEndpointKeys
    ) ||
    bridgeSkipsNearerTipOnPartnerEdge(
      b,
      a,
      edges,
      epsilonM,
      availableEndpointKeys
    )
  );
}

function bridgeSkipsNearerTipOnPartnerEdge(
  endpoint: Endpoint,
  partner: Endpoint,
  edges: LineFeature[],
  epsilonM: number,
  availableEndpointKeys?: Set<string>
): boolean {
  const edge = edges[partner.edgeIndex];
  if (!edge || edge.geometry.coordinates.length < 2) return false;
  const coords = edge.geometry.coordinates;
  const oppositeEnd: "a" | "b" = partner.end === "a" ? "b" : "a";
  const opposite =
    partner.end === "a" ? coords[coords.length - 1]! : coords[0]!;
  const distanceToPartner = haversineMeters(
    endpoint.coord[0],
    endpoint.coord[1],
    partner.coord[0],
    partner.coord[1]
  );
  const distanceToOpposite = haversineMeters(
    endpoint.coord[0],
    endpoint.coord[1],
    opposite[0],
    opposite[1]
  );
  if (!(distanceToOpposite + epsilonM < distanceToPartner)) return false;
  if (availableEndpointKeys) {
    const oppositeKey = `${partner.edgeIndex}:${oppositeEnd}`;
    if (!availableEndpointKeys.has(oppositeKey)) return false;
  }
  return true;
}

/** Choose the closest viable endpoint, preferring a nearby mid-road continuation. */
export function nearestBridgePartner(
  endpoint: Endpoint,
  freeEndpoints: Endpoint[],
  edges: LineFeature[],
  classifyPair: (a: Endpoint, b: Endpoint) => PairClassification,
  options: EdgeGapOptions,
  endpointIndex?: PointGridIndex<Endpoint>,
  selfCloseTipKeys?: Set<string>
): { other: Endpoint; distM: number } | null {
  let bestMid: { other: Endpoint; distM: number } | null = null;
  let bestAny: { other: Endpoint; distM: number } | null = null;

  const scanM = maxBridgeScanM(options);
  const radiusDeg = metersToDegPad(scanM * 1.15, endpoint.coord[1]);
  const candidates = endpointIndex
    ? endpointIndex.searchRadius(
        endpoint.coord[0],
        endpoint.coord[1],
        radiusDeg
      )
    : freeEndpoints;
  const availableKeys = new Set(
    freeEndpoints.map((candidate) => endpointKey(candidate))
  );

  for (const other of candidates) {
    if (other.edgeIndex === endpoint.edgeIndex) continue;
    const distM = haversineMeters(
      endpoint.coord[0],
      endpoint.coord[1],
      other.coord[0],
      other.coord[1]
    );
    if (distM <= options.connectedEpsilonM) continue;
    if (distM > scanM) continue;
    if (
      bridgeWouldDuplicateExistingEdge(
        endpoint,
        other,
        edges,
        options.connectedEpsilonM,
        availableKeys
      )
    ) {
      continue;
    }

    const { kind } = classifyPair(endpoint, other);
    // If mid-road bridging is disabled, do not let a nearer mid-road
    // candidate hide a farther topology/dead-end candidate that remains valid.
    if (kind === "mid-road" && !options.bridgeMidRoad) continue;
    if (!bestAny || distM < bestAny.distM) bestAny = { other, distM };
    if (kind === "mid-road" && (!bestMid || distM < bestMid.distM)) {
      bestMid = { other, distM };
    }
  }

  if (!bestMid) return bestAny;
  if (!bestAny) return bestMid;

  const anyKind = classifyPair(endpoint, bestAny.other).kind;
  if (anyKind === "mid-road") return bestAny;

  if (
    (anyKind === "dead-end" || anyKind === "topology") &&
    bestMid.distM <= Math.max(bestAny.distM * 2, bestAny.distM + 5) &&
    !selfCloseTipKeys?.has(endpointKey(bestMid.other))
  ) {
    return bestMid;
  }
  return bestAny;
}
