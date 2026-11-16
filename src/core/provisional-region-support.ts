import { lineString, point } from "@turf/helpers";
import length from "@turf/length";
import pointToLineDistance from "@turf/point-to-line-distance";
import type { Position } from "geojson";
import { CL_SAFE_MIN_LENGTH_M } from "./centerline-trust-config.js";
import { lineHasMajorityDualSideEdgeSupport } from "./centerline-corridor.js";
import type { Bbox, LineFeature } from "./types.js";

/** Keep fragments only when they can support a provisional-region decision. */
export function isMeaningfulProvisional(cl: LineFeature): boolean {
  try {
    return length(cl, { units: "meters" }) >= CL_SAFE_MIN_LENGTH_M;
  } catch {
    return false;
  }
}

export function workBboxEdgeLines(bbox: Bbox): LineFeature[] {
  const [west, south, east, north] = bbox;
  return [
    lineString([
      [west, south],
      [east, south],
    ]),
    lineString([
      [east, south],
      [east, north],
    ]),
    lineString([
      [east, north],
      [west, north],
    ]),
    lineString([
      [west, north],
      [west, south],
    ]),
  ];
}

function minDistToLinesM(coord: Position, lines: LineFeature[]): number {
  const pt = point(coord);
  let min = Infinity;
  for (const line of lines) {
    try {
      const distance = pointToLineDistance(pt, line, { units: "meters" });
      if (distance < min) min = distance;
    } catch {
      /* skip invalid */
    }
  }
  return min;
}

function ringTouchesLines(
  ring: Position[],
  lines: LineFeature[],
  thresholdM: number
): boolean {
  for (const coord of ring) {
    if (minDistToLinesM(coord, lines) <= thresholdM) return true;
  }
  return false;
}

export function touchesWorkBbox(
  ring: Position[],
  bboxEdges: LineFeature[],
  thresholdM: number
): boolean {
  return ringTouchesLines(ring, bboxEdges, thresholdM);
}

export function isNearAnyTrustBarrier(
  ring: Position[],
  barriers: LineFeature[],
  thresholdM: number
): boolean {
  if (barriers.length === 0) return false;
  return ringTouchesLines(ring, barriers, thresholdM);
}

/** Whether any intersecting provisional centerline has edge support on both sides. */
export function provisionalHasDualEdgeSupport(
  provisionalHitting: LineFeature[],
  edges: LineFeature[],
  maxHalfWidthM: number
): boolean {
  for (const centerline of provisionalHitting) {
    if (
      lineHasMajorityDualSideEdgeSupport(
        centerline.geometry.coordinates,
        edges,
        maxHalfWidthM,
        { intervalM: 8, maxSamples: 12 }
      )
    ) {
      return true;
    }
  }
  return false;
}
