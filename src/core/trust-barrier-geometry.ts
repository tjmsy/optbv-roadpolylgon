import lineIntersect from "@turf/line-intersect";
import { lineString } from "@turf/helpers";
import type { Position } from "geojson";
import type { LineFeature } from "./types.js";
import {
  haversineMeters,
  localVectorMeters,
  metersToDegPad,
  metersPerDegreeLongitude,
  offsetLocalMeters,
  METERS_PER_DEGREE_LATITUDE,
} from "./geodesy.js";
import {
  BBoxIndex,
  bboxesOverlap,
  expandBBox,
  lineFeatureBBox,
} from "./spatial-index.js";
import { TRUST_BARRIER_MAX_HALF_WIDTH_M } from "./trust-barrier-config.js";

export function coordDistMeters(a: Position, b: Position): number {
  return haversineMeters(a[0], a[1], b[0], b[1]);
}

function toLocalXY(
  coord: Position,
  origin: Position,
  mPerLon: number
): [number, number] {
  return [
    (coord[0]! - origin[0]!) * mPerLon,
    (coord[1]! - origin[1]!) * METERS_PER_DEGREE_LATITUDE,
  ];
}

function distPointToSegmentM(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Turf を使わない局所平面の点→線距離（m） */
export function minDistToLineBodyLocal(
  coord: Position,
  line: LineFeature
): number {
  const mPerLon = metersPerDegreeLongitude(coord[1]!);
  const [px, py] = toLocalXY(coord, coord, mPerLon);
  let min = Infinity;
  const coords = line.geometry.coordinates;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i]!;
    const b = coords[i + 1]!;
    const [ax, ay] = toLocalXY(a, coord, mPerLon);
    const [bx, by] = toLocalXY(b, coord, mPerLon);
    const d = distPointToSegmentM(px, py, ax, ay, bx, by);
    if (d < min) min = d;
  }
  return min;
}

function endpointTangent(
  coords: Position[],
  atStart: boolean
): Position | null {
  if (coords.length < 2) return null;
  if (atStart) {
    const distinct = coords
      .slice(1)
      .find((c) => coordDistMeters(coords[0], c) > 0.05);
    if (!distinct) return null;
    return [distinct[0] - coords[0][0], distinct[1] - coords[0][1]];
  }
  const end = coords[coords.length - 1];
  const distinct = coords
    .slice(0, -1)
    .reverse()
    .find((c) => coordDistMeters(end, c) > 0.05);
  if (!distinct) return null;
  return [end[0] - distinct[0], end[1] - distinct[1]];
}

export type SegEnd = {
  feature: LineFeature;
  trust: "safe" | "non-safe";
  atStart: boolean;
  coord: Position;
  tangent: Position | null;
};

export function collectEnds(
  features: LineFeature[],
  trust: "safe" | "non-safe"
): SegEnd[] {
  const ends: SegEnd[] = [];
  for (const feature of features) {
    const coords = feature.geometry.coordinates;
    if (coords.length < 2) continue;
    ends.push({
      feature,
      trust,
      atStart: true,
      coord: coords[0],
      tangent: endpointTangent(coords, true),
    });
    ends.push({
      feature,
      trust,
      atStart: false,
      coord: coords[coords.length - 1],
      tangent: endpointTangent(coords, false),
    });
  }
  return ends;
}

/**
 * 中心から接線に垂直な切断線を作り、左右の縁へスナップする。
 * 交差が取れない場合は、左右それぞれの最近縁点を使う。
 */
export function barrierLineAtPoint(
  center: Position,
  tangentLonLat: Position,
  edges: LineFeature[],
  maxHalfWidthM = TRUST_BARRIER_MAX_HALF_WIDTH_M,
  edgeIndex?: BBoxIndex<LineFeature>
): Position[] | null {
  const [tx, ty] = localVectorMeters(center, [
    center[0] + tangentLonLat[0],
    center[1] + tangentLonLat[1],
  ]);
  const tLen = Math.hypot(tx, ty);
  if (tLen < 1e-12) return null;
  const ntx = tx / tLen;
  const nty = ty / tLen;
  // 左法線（進行方向に対して）
  const nx = -nty;
  const ny = ntx;

  const leftFar = offsetLocalMeters(
    center,
    nx * maxHalfWidthM,
    ny * maxHalfWidthM
  );
  const rightFar = offsetLocalMeters(
    center,
    -nx * maxHalfWidthM,
    -ny * maxHalfWidthM
  );
  const cutter = lineString([leftFar, rightFar]);
  // 切断線自体と交差しない縁にも nearestOnSide でスナップするため、
  // 中心から半幅の正方形で候補を取る（切断線 bbox だけだと外側の境で空になる）。
  const searchPad = metersToDegPad(maxHalfWidthM * 1.5, center[1]!);
  const searchBbox = expandBBox(
    [center[0]!, center[1]!, center[0]!, center[1]!],
    searchPad
  );
  const edgeCandidates = edgeIndex
    ? edgeIndex.search(searchBbox)
    : edges.filter((edge) => bboxesOverlap(searchBbox, lineFeatureBBox(edge)));

  type Hit = { point: Position; alongM: number; distM: number };
  const hits: Hit[] = [];
  for (const edge of edgeCandidates) {
    try {
      const result = lineIntersect(cutter, edge);
      for (const feat of result.features) {
        const p = feat.geometry.coordinates;
        const [vx, vy] = localVectorMeters(center, p);
        const alongM = vx * nx + vy * ny;
        hits.push({
          point: p,
          alongM,
          distM: Math.hypot(vx, vy),
        });
      }
    } catch {
      // invalid geometry
    }
  }

  let leftHit: Hit | null = null;
  let rightHit: Hit | null = null;
  for (const hit of hits) {
    if (hit.alongM > 0.2 && hit.distM <= maxHalfWidthM) {
      if (!leftHit || hit.alongM < leftHit.alongM) leftHit = hit;
    } else if (hit.alongM < -0.2 && hit.distM <= maxHalfWidthM) {
      if (!rightHit || hit.alongM > rightHit.alongM) rightHit = hit;
    }
  }

  // 線交差が無い側は、法線側にある最近縁点へフォールバック
  const nearestOnSide = (side: 1 | -1): Position | null => {
    let best: Position | null = null;
    let bestDist = Infinity;
    for (const edge of edgeCandidates) {
      const coords = edge.geometry.coordinates;
      for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i];
        const b = coords[i + 1];
        // セグメント上の最近点（経緯度の簡易投影）
        const [ax, ay] = localVectorMeters(center, a);
        const [bx, by] = localVectorMeters(center, b);
        const dx = bx - ax;
        const dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        let t = lenSq === 0 ? 0 : -((ax * dx + ay * dy) / lenSq);
        t = Math.max(0, Math.min(1, t));
        const px = ax + t * dx;
        const py = ay + t * dy;
        const along = px * nx + py * ny;
        if (along * side <= 0.2) continue;
        const dist = Math.hypot(px, py);
        if (dist < bestDist && dist <= maxHalfWidthM) {
          bestDist = dist;
          best = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        }
      }
    }
    return best;
  };

  const left = leftHit?.point ?? nearestOnSide(1);
  const right = rightHit?.point ?? nearestOnSide(-1);
  if (!left || !right) return null;
  if (coordDistMeters(left, right) < 1) return null;

  // 縁バッファ（0.5m）と確実に重なるよう、端を外側へ少し延長する
  const extendM = 1.5;
  const [lx, ly] = localVectorMeters(center, left);
  const [rx, ry] = localVectorMeters(center, right);
  const leftLen = Math.hypot(lx, ly);
  const rightLen = Math.hypot(rx, ry);
  const leftExt =
    leftLen > 1e-9
      ? offsetLocalMeters(
          center,
          (lx / leftLen) * (leftLen + extendM),
          (ly / leftLen) * (leftLen + extendM)
        )
      : left;
  const rightExt =
    rightLen > 1e-9
      ? offsetLocalMeters(
          center,
          (rx / rightLen) * (rightLen + extendM),
          (ry / rightLen) * (rightLen + extendM)
        )
      : right;
  return [leftExt, rightExt];
}
