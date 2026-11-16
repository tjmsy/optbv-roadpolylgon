import type { Feature, Polygon, Position } from "geojson";
import type { LineFeature } from "./types.js";
import { BBoxIndex } from "./spatial-index.js";
import {
  metersPerDegreeLongitude,
  metersToSquareProjectionDegPad,
  METERS_PER_DEGREE_LONGITUDE_EQUATOR,
} from "./geodesy.js";

/** 過半数判定に使う最大サンプル数（周長に沿って等間隔） */
const MAX_DISTANCE_SAMPLE_VERTICES = 64;
/** @deprecated Legacy name; this module uses the square 111,320 m/° projection. */
export const M_PER_DEG_LAT = METERS_PER_DEGREE_LONGITUDE_EQUATOR;

export function metersPerDegLon(latDeg: number): number {
  return metersPerDegreeLongitude(latDeg);
}

function toLocalXY(coord: Position, mPerLon: number): [number, number] {
  return [coord[0]! * mPerLon, coord[1]! * M_PER_DEG_LAT];
}

function localDistM(a: Position, b: Position, mPerLon: number): number {
  const [ax, ay] = toLocalXY(a, mPerLon);
  const [bx, by] = toLocalXY(b, mPerLon);
  return Math.hypot(bx - ax, by - ay);
}

/** 点と線分の平面最短距離（局所メートル） */
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
  if (len2 === 0) {
    const ex = px - ax;
    const ey = py - ay;
    return Math.hypot(ex, ey);
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function minDistToLinesM(coord: Position, lines: LineFeature[]): number {
  const lat0 = coord[1]!;
  const mPerLon = metersPerDegLon(lat0);
  const [px, py] = toLocalXY(coord, mPerLon);
  let min = Infinity;
  for (const line of lines) {
    const coords = line.geometry.coordinates;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i]!;
      const b = coords[i + 1]!;
      const [ax, ay] = toLocalXY(a, mPerLon);
      const [bx, by] = toLocalXY(b, mPerLon);
      const d = distPointToSegmentM(px, py, ax, ay, bx, by);
      if (d < min) min = d;
    }
  }
  return min;
}

/** thresholdM を緯度方向の度に変換（点近傍の縁候補検索用） */
/**
 * thresholdM 以内に縁があるかだけ知りたいときの最短距離。
 * 索引があれば「閾値より遠い」ことを bbox 剪定だけで確定できる。
 */
export function minDistToLinesWithinThresholdM(
  coord: Position,
  lines: LineFeature[],
  thresholdM: number,
  edgeIndex?: BBoxIndex<LineFeature>
): number {
  if (!edgeIndex) return minDistToLinesM(coord, lines);
  const padDeg = metersToSquareProjectionDegPad(thresholdM, coord[1]!);
  const nearby = edgeIndex.searchPoint(coord[0]!, coord[1]!, padDeg);
  // 近傍 bbox に縁が無ければ threshold 超（呼び出し側は > threshold とみなす）
  if (nearby.length === 0) return thresholdM + 1;
  return minDistToLinesM(coord, nearby);
}

/**
 * 閉環から距離判定用サンプルを取る。
 * difference のバッファ接点では頂点が局所密集する。生頂点やインデックス等間隔
 * だと「過半数が CL 近傍」と誤判定しうる（例: 縁が pad にしか無い work 残余セル）。
 * 頂点数に関係なく、常に周長に沿った等間隔サンプルにする。
 */
export function sampleRingVertices(ring: Position[]): Position[] {
  const verts =
    ring.length > 1 &&
    ring[0]![0] === ring[ring.length - 1]![0] &&
    ring[0]![1] === ring[ring.length - 1]![1]
      ? ring.slice(0, -1)
      : [...ring];

  if (verts.length === 0) return [];
  if (verts.length === 1) return verts;

  const lat0 = verts[0]![1]!;
  const mPerLon = metersPerDegLon(lat0);
  const segLens: number[] = [];
  let total = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % verts.length]!;
    const len = localDistM(a, b, mPerLon);
    segLens.push(len);
    total += len;
  }
  const sampleCount = Math.min(
    Math.max(verts.length, 4),
    MAX_DISTANCE_SAMPLE_VERTICES
  );
  if (total < 1e-6) return verts.slice(0, sampleCount);

  const sampled: Position[] = [];
  for (let s = 0; s < sampleCount; s++) {
    const target = ((s + 0.5) / sampleCount) * total;
    let acc = 0;
    let picked = verts[0]!;
    for (let i = 0; i < verts.length; i++) {
      const len = segLens[i]!;
      if (acc + len >= target || i === verts.length - 1) {
        const a = verts[i]!;
        const b = verts[(i + 1) % verts.length]!;
        const t = len < 1e-9 ? 0 : (target - acc) / len;
        const tt = Math.min(1, Math.max(0, t));
        picked = [a[0]! + (b[0]! - a[0]!) * tt, a[1]! + (b[1]! - a[1]!) * tt];
        break;
      }
      acc += len;
    }
    sampled.push(picked);
  }
  return sampled;
}

/** 各頂点について、centerlines への最短距離の最大値 */
export function maxVertexDistanceToCenterlines(
  feature: Feature<Polygon>,
  centerlines: LineFeature[]
): number {
  if (centerlines.length === 0) return Infinity;
  const ring = feature.geometry.coordinates[0] ?? [];
  let maxMinDist = 0;
  for (const coord of sampleRingVertices(ring)) {
    const min = minDistToLinesM(coord, centerlines);
    if (min > maxMinDist) maxMinDist = min;
  }
  return maxMinDist;
}
