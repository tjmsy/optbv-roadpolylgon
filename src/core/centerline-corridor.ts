import type { Position } from "geojson";
import {
  haversineMeters,
  localVectorMeters,
  metersToDegPad,
} from "./geodesy.js";
import { BBoxIndex } from "./spatial-index.js";
import type { LineFeature } from "./types.js";

export function coordDistMeters(a: Position, b: Position): number {
  return haversineMeters(a[0], a[1], b[0], b[1]);
}

export function lineLengthMeters(coords: Position[]): number {
  let sum = 0;
  for (let i = 1; i < coords.length; i++) {
    sum += coordDistMeters(coords[i - 1], coords[i]);
  }
  return sum;
}

export { metersToDegPad } from "./geodesy.js";

function linesNearPoint(
  coord: Position,
  lines: LineFeature[] | BBoxIndex<LineFeature>,
  maxDistM: number
): LineFeature[] {
  if (lines instanceof BBoxIndex) {
    const pad = metersToDegPad(maxDistM * 1.15, coord[1]!);
    return lines.search([
      coord[0]! - pad,
      coord[1]! - pad,
      coord[0]! + pad,
      coord[1]! + pad,
    ]);
  }
  return lines;
}

export function minDistToLineLocal(coord: Position, line: LineFeature): number {
  const nearest = nearestPointOnEdgeLine(coord, line);
  return nearest ? nearest.distM : Infinity;
}

function projectPointOntoSegmentLocal(
  p: Position,
  a: Position,
  b: Position
): { point: Position; distSqM: number; tangentM: Position } {
  const [ax, ay] = localVectorMeters(p, a);
  const [bx, by] = localVectorMeters(p, b);
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    return { point: a, distSqM: ax * ax + ay * ay, tangentM: [0, 0] };
  }
  let t = -(ax * dx + ay * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * dx;
  const py = ay + t * dy;
  return {
    point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
    distSqM: px * px + py * py,
    tangentM: [dx, dy],
  };
}

function nearestPointOnEdgeLine(
  coord: Position,
  edge: LineFeature
): { point: Position; distM: number; edgeTangentM: Position } | null {
  const coords = edge.geometry.coordinates;
  if (coords.length < 2) return null;
  let best: Position | null = null;
  let bestTangentM: Position | null = null;
  let bestDistSq = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const projected = projectPointOntoSegmentLocal(
      coord,
      coords[i],
      coords[i + 1]
    );
    if (projected.distSqM < bestDistSq) {
      bestDistSq = projected.distSqM;
      best = projected.point;
      bestTangentM = projected.tangentM;
    }
  }
  return best && bestTangentM
    ? { point: best, distM: Math.sqrt(bestDistSq), edgeTangentM: bestTangentM }
    : null;
}

function minDistToEdgeBodies(
  coord: Position,
  edges: LineFeature[] | BBoxIndex<LineFeature>,
  thresholdM = Infinity
): number {
  const searchM = Number.isFinite(thresholdM) ? thresholdM : 50;
  const candidates = linesNearPoint(coord, edges, searchM);
  let min = Infinity;
  for (const edge of candidates) {
    const nearest = nearestPointOnEdgeLine(coord, edge);
    if (!nearest) continue;
    if (nearest.distM < min) min = nearest.distM;
    if (Number.isFinite(thresholdM) && min <= thresholdM) return min;
  }
  return min;
}

function hasDualSideEdgeSupport(
  coord: Position,
  tangent: Position | null,
  edges: LineFeature[] | BBoxIndex<LineFeature>,
  maxDistM: number
): boolean {
  if (!tangent) return false;
  const tangentEnd: Position = [coord[0] + tangent[0], coord[1] + tangent[1]];
  const [tx, ty] = localVectorMeters(coord, tangentEnd);
  const tLen = Math.sqrt(tx * tx + ty * ty);
  if (tLen < 1e-12) return false;

  const ntx = tx / tLen;
  const nty = ty / tLen;
  let hasLeft = false;
  let hasRight = false;

  for (const edge of linesNearPoint(coord, edges, maxDistM)) {
    const nearest = nearestPointOnEdgeLine(coord, edge);
    if (!nearest || nearest.distM > maxDistM) continue;

    const [vx, vy] = localVectorMeters(coord, nearest.point);
    const edgeLen = Math.hypot(
      nearest.edgeTangentM[0],
      nearest.edgeTangentM[1]
    );
    if (edgeLen < 1e-9) continue;

    const parallelCos = Math.abs(
      (ntx * nearest.edgeTangentM[0] + nty * nearest.edgeTangentM[1]) / edgeLen
    );
    if (parallelCos < 0.35) continue;
    const alongM = Math.abs(ntx * vx + nty * vy);
    const normalM = Math.abs(ntx * vy - nty * vx);
    if (alongM > Math.max(2, normalM)) continue;

    const cross = ntx * vy - nty * vx;
    if (cross > 0.05) hasLeft = true;
    if (cross < -0.05) hasRight = true;
    if (hasLeft && hasRight) return true;
  }
  return false;
}

interface LineSample {
  coord: Position;
  tangent: Position;
}

function sampleLineInterior(
  coords: Position[],
  intervalM = 5,
  maxSamples = 8
): LineSample[] {
  const totalM = lineLengthMeters(coords);
  if (coords.length < 2 || totalM <= 0) return [];

  const count = Math.min(
    maxSamples,
    Math.max(1, Math.ceil(totalM / intervalM))
  );
  const samples: LineSample[] = [];
  let segIndex = 0;
  let segmentStartM = 0;
  let segmentLengthM = coordDistMeters(coords[0], coords[1]);

  for (let sampleIndex = 0; sampleIndex < count; sampleIndex++) {
    const targetM = ((sampleIndex + 0.5) / count) * totalM;
    while (
      segIndex < coords.length - 2 &&
      targetM > segmentStartM + segmentLengthM
    ) {
      segmentStartM += segmentLengthM;
      segIndex++;
      segmentLengthM = coordDistMeters(coords[segIndex], coords[segIndex + 1]);
    }
    if (segmentLengthM <= 0) continue;
    const t = Math.max(
      0,
      Math.min(1, (targetM - segmentStartM) / segmentLengthM)
    );
    const a = coords[segIndex];
    const b = coords[segIndex + 1];
    samples.push({
      coord: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
      tangent: [b[0] - a[0], b[1] - a[1]],
    });
  }
  return samples;
}

export function isSegmentInCorridor(
  coords: Position[],
  edges: LineFeature[] | BBoxIndex<LineFeature>,
  maxDistM: number,
  requireDualSide: boolean
): boolean {
  if (coords.length < 2) return false;
  for (const coord of coords) {
    if (minDistToEdgeBodies(coord, edges, maxDistM) > maxDistM) return false;
  }
  if (!requireDualSide) return true;
  return lineHasMajorityDualSideEdgeSupport(coords, edges, maxDistM);
}

export function lineHasMajorityDualSideEdgeSupport(
  coords: Position[],
  edges: LineFeature[] | BBoxIndex<LineFeature>,
  maxDistM: number,
  options?: { intervalM?: number; maxSamples?: number; minFraction?: number }
): boolean {
  const intervalM = options?.intervalM ?? 5;
  const maxSamples = options?.maxSamples ?? 8;
  const minFraction = options?.minFraction ?? 0.5;
  const edgeIndex =
    edges instanceof BBoxIndex ? edges : BBoxIndex.fromLineFeatures(edges);
  const samples = sampleLineInterior(coords, intervalM, maxSamples);
  if (samples.length === 0) return false;
  let dualSupportCount = 0;
  for (const sample of samples) {
    if (
      hasDualSideEdgeSupport(sample.coord, sample.tangent, edgeIndex, maxDistM)
    ) {
      dualSupportCount++;
    }
  }
  return dualSupportCount / samples.length >= minFraction;
}

const CORRIDOR_SPLIT_SAMPLE_M = 2;

export function splitByCorridorDistance(
  coords: Position[],
  edges: LineFeature[] | BBoxIndex<LineFeature>,
  maxDistM: number
): { coords: Position[]; inCorridor: boolean }[] {
  if (coords.length < 2) return [];
  const totalM = lineLengthMeters(coords);
  if (totalM <= 0) return [];

  const sampleCount = Math.max(
    2,
    Math.ceil(totalM / CORRIDOR_SPLIT_SAMPLE_M) + 1
  );
  const samples: { coord: Position; inCorridor: boolean }[] = [];
  let segIndex = 0;
  let segmentStartM = 0;
  let segmentLengthM = coordDistMeters(coords[0], coords[1]);

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const targetM =
      sampleCount === 1 ? 0 : (sampleIndex / (sampleCount - 1)) * totalM;
    while (
      segIndex < coords.length - 2 &&
      targetM > segmentStartM + segmentLengthM
    ) {
      segmentStartM += segmentLengthM;
      segIndex++;
      segmentLengthM = coordDistMeters(coords[segIndex], coords[segIndex + 1]);
    }
    const t =
      segmentLengthM <= 0
        ? 0
        : Math.max(0, Math.min(1, (targetM - segmentStartM) / segmentLengthM));
    const a = coords[segIndex];
    const b = coords[segIndex + 1];
    const coord: Position = [
      a[0] + t * (b[0] - a[0]),
      a[1] + t * (b[1] - a[1]),
    ];
    samples.push({
      coord,
      inCorridor: minDistToEdgeBodies(coord, edges, maxDistM) <= maxDistM,
    });
  }

  const runs: { coords: Position[]; inCorridor: boolean }[] = [];
  let runCoords: Position[] = [samples[0].coord];
  let runFlag = samples[0].inCorridor;

  for (let i = 1; i < samples.length; i++) {
    const sample = samples[i];
    if (sample.inCorridor === runFlag) {
      runCoords.push(sample.coord);
      continue;
    }
    const prev = samples[i - 1].coord;
    const mid: Position = [
      (prev[0] + sample.coord[0]) / 2,
      (prev[1] + sample.coord[1]) / 2,
    ];
    if (coordDistMeters(runCoords[runCoords.length - 1], mid) > 0.05) {
      runCoords.push(mid);
    }
    if (runCoords.length >= 2)
      runs.push({ coords: runCoords, inCorridor: runFlag });
    runCoords = [mid];
    if (coordDistMeters(mid, sample.coord) > 0.05) runCoords.push(sample.coord);
    runFlag = sample.inCorridor;
  }
  if (runCoords.length >= 2)
    runs.push({ coords: runCoords, inCorridor: runFlag });
  return runs;
}
