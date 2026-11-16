import type { Position } from "geojson";
import { edgeLengthMeters } from "./edge-gap-geometry.js";
import { OVERLAP_MAX_LENGTH_RATIO } from "./coalesce-edges-config.js";
import { metersToDegPad, localVectorMetersAtLatitude } from "./geodesy.js";
import type { LineFeature } from "./types.js";
import {
  bboxesOverlap,
  expandBBox,
  lineFeatureBBox,
  type BBox4,
} from "./spatial-index.js";
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

function pointOnEdgeBody(
  coord: Position,
  edge: LineFeature,
  epsilonM: number
): boolean {
  const [px, py] = localVectorMetersAtLatitude(coord, coord);
  const coords = edge.geometry.coordinates;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i]!;
    const b = coords[i + 1]!;
    const [ax, ay] = localVectorMetersAtLatitude(coord, a);
    const [bx, by] = localVectorMetersAtLatitude(coord, b);
    if (distPointToSegmentM(px, py, ax, ay, bx, by) <= epsilonM) return true;
  }
  return false;
}

/**
 * 短い縁が長い縁の線体に沿っているか。
 * 頂点だけでなく各セグメント中点も見る — U 縁の両端だけを結ぶ口弦は
 * 端点が線体上でも中点が離れるため overlap 断片としない。
 */
function edgeLiesOnOtherBody(
  shorter: LineFeature,
  longer: LineFeature,
  epsilonM: number
): boolean {
  const shortCoords = shorter.geometry.coordinates;
  if (shortCoords.length < 2) return false;
  for (const coord of shortCoords) {
    if (!pointOnEdgeBody(coord, longer, epsilonM)) return false;
  }
  for (let i = 0; i < shortCoords.length - 1; i++) {
    const a = shortCoords[i]!;
    const b = shortCoords[i + 1]!;
    const mid: Position = [(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2];
    if (!pointOnEdgeBody(mid, longer, epsilonM)) return false;
  }
  return true;
}

/** Pass A: 厳密に長い縁に載る短い断片を落とす */
export function dropOverlapFragments(
  edges: LineFeature[],
  epsilonM: number,
  maxLengthRatio = OVERLAP_MAX_LENGTH_RATIO
): { edges: LineFeature[]; dropped: number } {
  if (edges.length <= 1) return { edges: [...edges], dropped: 0 };

  const lengths = edges.map((e) => edgeLengthMeters(e.geometry.coordinates));
  const boxes: BBox4[] = edges.map((e) => lineFeatureBBox(e));
  const keep = new Array(edges.length).fill(true);
  let dropped = 0;

  // 短い順に見て、より長い残存縁に載っていれば落とす
  const order = lengths
    .map((len, i) => ({ len, i }))
    .sort((a, b) => a.len - b.len);

  for (const { i, len } of order) {
    if (!keep[i]) continue;
    if (len < 1e-9) {
      keep[i] = false;
      dropped++;
      continue;
    }
    const shortBox = boxes[i]!;
    const lat = edges[i]!.geometry.coordinates[0]![1]!;
    const pad = metersToDegPad(epsilonM, lat);
    const query = expandBBox(shortBox, pad);
    for (let j = 0; j < edges.length; j++) {
      if (i === j || !keep[j]) continue;
      if (lengths[j]! <= len) continue;
      // ほぼ同長は対向縁の可能性が高い。断片スクラップは長い縁の一部のはず。
      if (len / lengths[j]! > maxLengthRatio) continue;
      if (!bboxesOverlap(query, boxes[j]!)) continue;
      if (edgeLiesOnOtherBody(edges[i]!, edges[j]!, epsilonM)) {
        keep[i] = false;
        dropped++;
        break;
      }
    }
  }

  return {
    edges: edges.filter((_, i) => keep[i]),
    dropped,
  };
}
