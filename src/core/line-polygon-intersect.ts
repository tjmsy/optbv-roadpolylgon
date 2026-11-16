/**
 * Polygon × LineString の高速交差判定（Turf booleanIntersects 代替）。
 *
 * 1) 線頂点・線上サンプルの point-in-polygon（大半のケース）
 * 2) 線 bbox と重なるリング辺だけ線分交差（角クリップ用）
 */
import type { Feature, LineString, Polygon, Position } from "geojson";
import { coordsBBox, bboxesOverlap, type BBox4 } from "./spatial-index.js";

function pointOnSegment(p: Position, a: Position, b: Position): boolean {
  const abx = b[0]! - a[0]!;
  const aby = b[1]! - a[1]!;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-24) return false;
  const cross = (p[1]! - a[1]!) * abx - (p[0]! - a[0]!) * aby;
  if (Math.abs(cross) > 1e-12) return false;
  const dot = (p[0]! - a[0]!) * abx + (p[1]! - a[1]!) * aby;
  if (dot < 0) return false;
  return dot <= lenSq + 1e-18;
}

/** 点がリング内か（ray casting。境界上は true） */
export function pointInRing(point: Position, ring: Position[]): boolean {
  const x = point[0]!;
  const y = point[1]!;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    const xi = a[0]!;
    const yi = a[1]!;
    const xj = b[0]!;
    const yj = b[1]!;
    if (xi === xj && yi === yj) continue;

    if (pointOnSegment(point, a, b)) return true;

    const dy = yj - yi;
    if (dy === 0) continue;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / dy + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point: Position, polygon: Feature<Polygon>): boolean {
  const rings = polygon.geometry.coordinates;
  if (rings.length === 0) return false;
  if (!pointInRing(point, rings[0]!)) return false;
  for (let h = 1; h < rings.length; h++) {
    if (pointInRing(point, rings[h]!)) return false;
  }
  return true;
}

/** 線分交差（端点共有・コリニア上の重なり含む） */
export function segmentsIntersect(
  a: Position,
  b: Position,
  c: Position,
  d: Position
): boolean {
  const orient = (p: Position, q: Position, r: Position) => {
    const v =
      (q[1]! - p[1]!) * (r[0]! - q[0]!) - (q[0]! - p[0]!) * (r[1]! - q[1]!);
    if (Math.abs(v) < 1e-18) return 0;
    return v > 0 ? 1 : 2;
  };
  const onSeg = (p: Position, q: Position, r: Position) =>
    q[0]! <= Math.max(p[0]!, r[0]!) + 1e-15 &&
    q[0]! >= Math.min(p[0]!, r[0]!) - 1e-15 &&
    q[1]! <= Math.max(p[1]!, r[1]!) + 1e-15 &&
    q[1]! >= Math.min(p[1]!, r[1]!) - 1e-15;

  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSeg(a, c, b)) return true;
  if (o2 === 0 && onSeg(a, d, b)) return true;
  if (o3 === 0 && onSeg(c, a, d)) return true;
  if (o4 === 0 && onSeg(c, b, d)) return true;
  return false;
}

function segBBox(a: Position, b: Position): BBox4 {
  return [
    Math.min(a[0]!, b[0]!),
    Math.min(a[1]!, b[1]!),
    Math.max(a[0]!, b[0]!),
    Math.max(a[1]!, b[1]!),
  ];
}

/** 線に沿って最大 maxSamples 点をサンプル（端点含む） */
function sampleLinePoints(coords: Position[], maxSamples: number): Position[] {
  if (coords.length === 0) return [];
  if (coords.length === 1) return [coords[0]!];
  const out: Position[] = [];
  const n = Math.max(2, Math.min(maxSamples, coords.length * 2));
  for (let s = 0; s < n; s++) {
    const t = s / (n - 1);
    const f = t * (coords.length - 1);
    const i = Math.min(Math.floor(f), coords.length - 2);
    const u = f - i;
    const a = coords[i]!;
    const b = coords[i + 1]!;
    out.push([a[0]! + u * (b[0]! - a[0]!), a[1]! + u * (b[1]! - a[1]!)]);
  }
  return out;
}

/**
 * LineString が Polygon と交差するか。
 */
export function lineIntersectsPolygon(
  line: Feature<LineString>,
  polygon: Feature<Polygon>
): boolean {
  const coords = line.geometry.coordinates;
  if (coords.length < 2) return false;
  const rings = polygon.geometry.coordinates;
  if (rings.length === 0) return false;

  // 1) 安い PIP サンプル（内部通過の大半をここで拾う）
  for (const c of sampleLinePoints(coords, 12)) {
    if (pointInPolygon(c, polygon)) return true;
  }

  // 2) 境界クリップ: 線 bbox と重なるリング辺だけ線分交差
  const lineBox = coordsBBox(coords);
  for (const ring of rings) {
    if (ring.length < 2) continue;
    for (let j = 0; j < ring.length - 1; j++) {
      const ra = ring[j]!;
      const rb = ring[j + 1]!;
      if (ra[0] === rb[0] && ra[1] === rb[1]) continue;
      const edgeBox = segBBox(ra, rb);
      if (!bboxesOverlap(lineBox, edgeBox)) continue;
      for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i]!;
        const b = coords[i + 1]!;
        if (!bboxesOverlap(segBBox(a, b), edgeBox)) continue;
        if (segmentsIntersect(a, b, ra, rb)) return true;
      }
    }
  }

  return false;
}
