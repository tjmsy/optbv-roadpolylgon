import lineIntersect from "@turf/line-intersect";
import { lineString } from "@turf/helpers";
import type { Position } from "geojson";
import { haversineMeters } from "./geodesy.js";
import {
  BBoxIndex,
  bboxesOverlap,
  coordsBBox,
  lineFeatureBBox,
} from "./spatial-index.js";
import type { LineFeature } from "./types.js";

export interface CenterlineCrossing {
  segIndex: number;
  point: Position;
}

function coordDistMeters(a: Position, b: Position): number {
  return haversineMeters(a[0], a[1], b[0], b[1]);
}

/** Find boundary intersections and order them along the centerline. */
export function findEdgeCrossings(
  clCoords: Position[],
  boundaries: LineFeature[] | BBoxIndex<LineFeature>
): CenterlineCrossing[] {
  if (clCoords.length < 2) return [];

  const clLine = lineString(clCoords);
  const clBbox = coordsBBox(clCoords);
  const candidates =
    boundaries instanceof BBoxIndex
      ? boundaries.search(clBbox)
      : boundaries.filter((edge) =>
          bboxesOverlap(clBbox, lineFeatureBBox(edge))
        );
  const crossings: (CenterlineCrossing & { distFromStart: number })[] = [];

  for (const edge of candidates) {
    try {
      const result = lineIntersect(clLine, edge);
      for (const feature of result.features) {
        const point = feature.geometry.coordinates;
        const segIndex = findSegmentIndex(clCoords, point);
        if (segIndex >= 0) {
          const distFromStart = cumulativeDistToSegment(
            clCoords,
            segIndex,
            point
          );
          crossings.push({ segIndex, point, distFromStart });
        }
      }
    } catch {
      // Ignore invalid geometry as the original pipeline did.
    }
  }

  crossings.sort((a, b) => a.distFromStart - b.distFromStart);
  const deduped: typeof crossings = [];
  for (const crossing of crossings) {
    const last = deduped[deduped.length - 1];
    if (last && coordDistMeters(last.point, crossing.point) < 0.1) continue;
    deduped.push(crossing);
  }

  return deduped.map(({ segIndex, point }) => ({ segIndex, point }));
}

export function cumulativeDistToSegment(
  coords: Position[],
  segIdx: number,
  pointOnSeg: Position
): number {
  let distance = 0;
  for (let i = 0; i < segIdx; i++) {
    distance += coordDistMeters(coords[i], coords[i + 1]);
  }
  distance += coordDistMeters(coords[segIdx], pointOnSeg);
  return distance;
}

function findSegmentIndex(coords: Position[], point: Position): number {
  let bestIdx = -1;
  let bestDist = Infinity;

  for (let i = 0; i < coords.length - 1; i++) {
    const distance = pointToSegmentDist(point, coords[i], coords[i + 1]);
    if (distance < bestDist) {
      bestDist = distance;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function pointToSegmentDist(p: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return coordDistMeters(p, a);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projected: Position = [a[0] + t * dx, a[1] + t * dy];
  return coordDistMeters(p, projected);
}

/** Split a centerline coordinate sequence at its ordered boundary crossings. */
export function splitAtCrossings(
  coords: Position[],
  crossings: CenterlineCrossing[]
): Position[][] {
  if (crossings.length === 0) return [coords];

  const segments: Position[][] = [];
  let current: Position[] = [coords[0]];
  let crossIdx = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    while (crossIdx < crossings.length && crossings[crossIdx].segIndex === i) {
      const crossingPoint = crossings[crossIdx].point;
      const lastPoint = current[current.length - 1];
      if (coordDistMeters(lastPoint, crossingPoint) > 0.05) {
        current.push(crossingPoint);
      }
      if (current.length >= 2) segments.push(current);
      current = [crossingPoint];
      crossIdx++;
    }
    if (coordDistMeters(current[current.length - 1], coords[i + 1]) > 0.05) {
      current.push(coords[i + 1]);
    }
  }

  while (crossIdx < crossings.length) {
    const crossingPoint = crossings[crossIdx].point;
    const lastPoint = current[current.length - 1];
    if (coordDistMeters(lastPoint, crossingPoint) > 0.05) {
      current.push(crossingPoint);
    }
    if (current.length >= 2) segments.push(current);
    current = [crossingPoint];
    crossIdx++;
  }

  if (current.length >= 2) segments.push(current);
  return segments;
}
