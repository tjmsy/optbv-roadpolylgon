import type { Position } from "geojson";
import { haversineMeters, localVectorMeters } from "./geodesy.js";
import { BBoxIndex, expandBBox } from "./spatial-index.js";
import type { LineFeature } from "./types.js";

const GAP_TOUCH_THRESHOLD_M = 0.5;

interface TouchedGap {
  gap: LineFeature;
  touchesStart: boolean;
  touchesEnd: boolean;
}

export interface GapTouchInfo {
  touchesGap: boolean;
  startTouchesGap: boolean;
  endTouchesGap: boolean;
  touchedGaps: TouchedGap[];
}

export type GapSideStatus =
  "not-applicable" | "inside" | "outside" | "ambiguous";

type LineDistance = (coord: Position, line: LineFeature) => number;
type DegreePadding = (meters: number, latitude: number) => number;

export function segmentTouchesAnyGap(
  coords: Position[],
  unbridgedGaps: LineFeature[] | BBoxIndex<LineFeature>,
  minDistanceToLine: LineDistance,
  metersToDegPad: DegreePadding
): GapTouchInfo {
  const info: GapTouchInfo = {
    touchesGap: false,
    startTouchesGap: false,
    endTouchesGap: false,
    touchedGaps: [],
  };
  if (coords.length < 2) return info;
  const gapList = unbridgedGaps instanceof BBoxIndex ? null : unbridgedGaps;
  if (gapList && gapList.length === 0) return info;
  if (unbridgedGaps instanceof BBoxIndex && unbridgedGaps.size === 0) {
    return info;
  }

  const start = coords[0]!;
  const end = coords[coords.length - 1]!;
  const pad = metersToDegPad(GAP_TOUCH_THRESHOLD_M * 2, start[1]!);
  const candidates = new Set<LineFeature>();
  if (unbridgedGaps instanceof BBoxIndex) {
    for (const gap of unbridgedGaps.search(
      expandBBox([start[0]!, start[1]!, start[0]!, start[1]!], pad)
    )) {
      candidates.add(gap);
    }
    for (const gap of unbridgedGaps.search(
      expandBBox([end[0]!, end[1]!, end[0]!, end[1]!], pad)
    )) {
      candidates.add(gap);
    }
  } else {
    for (const gap of unbridgedGaps) candidates.add(gap);
  }

  for (const gap of candidates) {
    const touchesStart = minDistanceToLine(start, gap) <= GAP_TOUCH_THRESHOLD_M;
    const touchesEnd = minDistanceToLine(end, gap) <= GAP_TOUCH_THRESHOLD_M;
    if (touchesStart) {
      info.startTouchesGap = true;
      info.touchesGap = true;
    }
    if (touchesEnd) {
      info.endTouchesGap = true;
      info.touchesGap = true;
    }
    if (touchesStart || touchesEnd) {
      info.touchedGaps.push({ gap, touchesStart, touchesEnd });
    }
  }
  return info;
}

function coordDistMeters(a: Position, b: Position): number {
  return haversineMeters(a[0], a[1], b[0], b[1]);
}

function normalizeVector(vector: Position): Position | null {
  const length = Math.hypot(vector[0], vector[1]);
  return length > 1e-9 ? [vector[0] / length, vector[1] / length] : null;
}

function edgeInwardVectorAtGap(
  edge: LineFeature,
  gap: LineFeature
): Position | null {
  const edgeCoords = edge.geometry.coordinates;
  const gapCoords = gap.geometry.coordinates;
  if (edgeCoords.length < 2 || gapCoords.length < 2) return null;

  const candidates = [
    { endpoint: edgeCoords[0], inward: edgeCoords[1] },
    {
      endpoint: edgeCoords[edgeCoords.length - 1],
      inward: edgeCoords[edgeCoords.length - 2],
    },
  ];
  let best: (typeof candidates)[number] | null = null;
  let bestDistanceM = Infinity;
  for (const candidate of candidates) {
    for (const gapEndpoint of [gapCoords[0], gapCoords[gapCoords.length - 1]]) {
      const distanceM = coordDistMeters(candidate.endpoint, gapEndpoint);
      if (distanceM < bestDistanceM) {
        best = candidate;
        bestDistanceM = distanceM;
      }
    }
  }
  if (!best || bestDistanceM > 2) return null;
  return normalizeVector(localVectorMeters(best.endpoint, best.inward));
}

function explicitGapEdgeIndexes(
  gap: LineFeature,
  edges: LineFeature[]
): [number, number] | null {
  const properties = gap.properties ?? {};
  const explicit = [properties.edgeA, properties.edgeB].filter(
    (value): value is number =>
      typeof value === "number" && Number.isInteger(value) && !!edges[value]
  );
  const unique = [...new Set(explicit)];
  return unique.length === 2 ? [unique[0], unique[1]] : null;
}

function roadTerminusInwardVector(
  gap: LineFeature,
  edges: LineFeature[]
): Position | null {
  const indexes = explicitGapEdgeIndexes(gap, edges);
  if (!indexes) return null;
  const first = edgeInwardVectorAtGap(edges[indexes[0]], gap);
  const second = edgeInwardVectorAtGap(edges[indexes[1]], gap);
  if (!first || !second) return null;
  if (first[0] * second[0] + first[1] * second[1] < 0.3) return null;
  return normalizeVector([first[0] + second[0], first[1] + second[1]]);
}

export function isOnRoadSideOfGapTermini(
  coords: Position[],
  gapTouch: GapTouchInfo,
  edges: LineFeature[]
): GapSideStatus {
  let evaluated = false;
  for (const touched of gapTouch.touchedGaps) {
    const inward = roadTerminusInwardVector(touched.gap, edges);
    if (!inward) continue;

    let awayFromGap: Position | null = null;
    if (touched.touchesStart && !touched.touchesEnd) {
      const distinct = coords
        .slice(1)
        .find((coord) => coordDistMeters(coords[0], coord) > 0.05);
      if (distinct) awayFromGap = localVectorMeters(coords[0], distinct);
    } else if (touched.touchesEnd && !touched.touchesStart) {
      const end = coords[coords.length - 1];
      const distinct = coords
        .slice(0, -1)
        .reverse()
        .find((coord) => coordDistMeters(end, coord) > 0.05);
      if (distinct) awayFromGap = localVectorMeters(end, distinct);
    } else {
      return "outside";
    }
    const away = awayFromGap ? normalizeVector(awayFromGap) : null;
    if (!away) return "ambiguous";

    evaluated = true;
    if (away[0] * inward[0] + away[1] * inward[1] <= 0.5) return "outside";
  }
  return evaluated ? "inside" : "not-applicable";
}
