import type { Position } from "geojson";
import {
  acuteAngleDifferenceDeg,
  bearingDegrees,
} from "./edge-gap-geometry.js";
import { haversineMeters, localVectorMetersAtLatitude } from "./geodesy.js";
import type { EdgeGapKind, EdgeGapOptions } from "./edge-gap-config.js";
import {
  BBoxIndex,
  bboxesOverlap,
  expandBBox,
  lineFeatureBBox,
} from "./spatial-index.js";
import type { LineFeature } from "./types.js";
import { metersToDegPad } from "./geodesy.js";

export interface CenterlineContext {
  distToLineM: number;
  segmentBearing: number;
  distToEndpointM: number;
}

export interface PairClassification {
  cl: CenterlineContext | null;
  kind: EdgeGapKind;
  angleToClDeg: number | null;
}

export { metersToDegPad } from "./geodesy.js";

function toLocalXY(
  lon: number,
  lat: number,
  originLon: number,
  originLat: number
): [number, number] {
  return localVectorMetersAtLatitude(
    [originLon, originLat],
    [lon, lat],
    originLat
  );
}

export function minDistToLineLocal(
  lon: number,
  lat: number,
  line: LineFeature
): { distM: number; segIndex: number } {
  const hit = nearestPointToLineLocal(lon, lat, line);
  return { distM: hit.distM, segIndex: hit.segIndex };
}

function nearestPointToLineLocal(
  lon: number,
  lat: number,
  line: LineFeature
): { distM: number; segIndex: number; point: Position } {
  const [px, py] = toLocalXY(lon, lat, lon, lat);
  const coords = line.geometry.coordinates;
  let min = Infinity;
  let segIndex = 0;
  let tBest = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i]!;
    const b = coords[i + 1]!;
    const [ax, ay] = toLocalXY(a[0]!, a[1]!, lon, lat);
    const [bx, by] = toLocalXY(b[0]!, b[1]!, lon, lat);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = 0;
    if (len2 > 0) {
      t = ((px - ax) * dx + (py - ay) * dy) / len2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const distance = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (distance < min) {
      min = distance;
      segIndex = i;
      tBest = t;
    }
  }

  const a = coords[segIndex]!;
  const b = coords[segIndex + 1]!;
  return {
    distM: min,
    segIndex,
    point: [a[0]! + (b[0]! - a[0]!) * tBest, a[1]! + (b[1]! - a[1]!) * tBest],
  };
}

export function centerlineContext(
  lon: number,
  lat: number,
  centerlines: LineFeature[] | BBoxIndex<LineFeature>,
  hintM = 80
): CenterlineContext | null {
  let bestDist = Infinity;
  let bestBearing = 0;
  let bestEndDist = Infinity;

  const pad = metersToDegPad(hintM, lat);
  const query: [number, number, number, number] = [
    lon - pad,
    lat - pad,
    lon + pad,
    lat + pad,
  ];
  const candidates =
    centerlines instanceof BBoxIndex
      ? centerlines.search(query)
      : centerlines.filter((cl) =>
          bboxesOverlap(query, expandBBox(lineFeatureBBox(cl), 0))
        );

  for (const cl of candidates) {
    const coords = cl.geometry.coordinates;
    if (coords.length < 2) continue;

    const a0 = coords[0]!;
    const a1 = coords[coords.length - 1]!;
    const { distM, segIndex } = minDistToLineLocal(lon, lat, cl);
    if (distM >= bestDist) continue;

    const p = coords[segIndex]!;
    const q = coords[segIndex + 1]!;
    bestDist = distM;
    bestBearing = bearingDegrees(p[0]!, p[1]!, q[0]!, q[1]!);
    // Keep endpoint distance paired with the same centerline that supplied
    // the nearest-line distance and bearing. A nearby endpoint on an
    // unrelated line must not turn a mid-road gap into a dead end.
    bestEndDist = Math.min(
      haversineMeters(lon, lat, a0[0]!, a0[1]!),
      haversineMeters(lon, lat, a1[0]!, a1[1]!)
    );
  }

  if (bestDist === Infinity) return null;
  return {
    distToLineM: bestDist,
    segmentBearing: bestBearing,
    distToEndpointM: bestEndDist,
  };
}

export function classifyEdgeGap(
  bridgeBearing: number,
  cl: CenterlineContext | null,
  options: EdgeGapOptions
): { kind: EdgeGapKind; angleToClDeg: number | null } {
  if (!cl || cl.distToLineM > options.clHintM) {
    return { kind: "topology", angleToClDeg: null };
  }

  const angleToClDeg = acuteAngleDifferenceDeg(
    bridgeBearing,
    cl.segmentBearing
  );
  const nearClEnd = cl.distToEndpointM <= options.clEndpointNearM;
  const confidentNear = cl.distToLineM <= options.clNearM;

  if (
    confidentNear &&
    nearClEnd &&
    angleToClDeg >= options.perpendicularMinDeg
  ) {
    return { kind: "dead-end", angleToClDeg };
  }

  if (angleToClDeg <= options.parallelMaxDeg) {
    return { kind: "mid-road", angleToClDeg };
  }
  return { kind: "topology", angleToClDeg };
}
