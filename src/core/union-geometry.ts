import bbox from "@turf/bbox";
import booleanIntersects from "@turf/boolean-intersects";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import polygonClipping from "polygon-clipping";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
export type PolyFeature = Feature<Polygon | MultiPolygon>;
export type BBox4 = [number, number, number, number];
/** polygon-clipping: Ring = [number, number][] */
export type PcRing = [number, number][];
export type PcPolygon = PcRing[];
export type PcMultiPolygon = PcPolygon[];
export type PcGeom = PcPolygon | PcMultiPolygon;

/** polygon-clipping.union 互換。テストで注入する。 */
export type PcUnionFn = (
  ...geoms: Array<PcPolygon | PcMultiPolygon>
) => PcMultiPolygon;

const BBOX_PAD_DEG = 1e-6;
/** 一度に pcUnion へ渡す geom 数（引数過多・巨大中間結果を避ける） */
const PC_UNION_CHUNK = 32;

let activePcUnion: PcUnionFn = polygonClipping.union as PcUnionFn;

/** テスト用: polygon-clipping.union を差し替える。null で既定に戻す。 */
export function setPcUnionForTests(fn: PcUnionFn | null): void {
  activePcUnion = fn ?? (polygonClipping.union as PcUnionFn);
}

export function featureBbox(f: PolyFeature): BBox4 {
  return bbox(f) as BBox4;
}

export function bboxesOverlap(a: BBox4, b: BBox4, pad = BBOX_PAD_DEG): boolean {
  return !(
    a[2] + pad < b[0] ||
    b[2] + pad < a[0] ||
    a[3] + pad < b[1] ||
    b[3] + pad < a[1]
  );
}

function toPcPolygon(coords: Position[][]): PcPolygon {
  return coords.map((ring) =>
    ring.map((p) => [p[0]!, p[1]!] as [number, number])
  );
}

export function toPcGeoms(f: PolyFeature): PcGeom {
  if (f.geometry.type === "Polygon") {
    return toPcPolygon(f.geometry.coordinates);
  }
  return f.geometry.coordinates.map((poly) => toPcPolygon(poly));
}

export function fromPcMultiPolygon(coords: PcMultiPolygon): PolyFeature {
  if (coords.length === 1) {
    return {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: coords[0]! },
    };
  }
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "MultiPolygon", coordinates: coords },
  };
}

export function polygonParts(f: PolyFeature): Position[][][] {
  if (f.geometry.type === "Polygon") {
    return [f.geometry.coordinates];
  }
  return f.geometry.coordinates;
}

export function concatMultiPolygon(
  a: PolyFeature,
  b: PolyFeature
): PolyFeature {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "MultiPolygon",
      coordinates: [...polygonParts(a), ...polygonParts(b)],
    },
  };
}

function bboxCenterX(f: PolyFeature): number {
  const b = featureBbox(f);
  return (b[0] + b[2]) / 2;
}

function bboxCenterY(f: PolyFeature): number {
  const b = featureBbox(f);
  return (b[1] + b[3]) / 2;
}

export function sortSpatially(features: PolyFeature[]): PolyFeature[] {
  return [...features].sort((a, b) => {
    const dx = bboxCenterX(a) - bboxCenterX(b);
    if (Math.abs(dx) > 1e-12) return dx;
    return bboxCenterY(a) - bboxCenterY(b);
  });
}

function asMultiPolygon(g: PcGeom): PcMultiPolygon {
  const firstCoord = g[0]?.[0]?.[0];
  return typeof firstCoord === "number"
    ? [g as PcPolygon]
    : (g as PcMultiPolygon);
}

/**
 * polygon-clipping で複数 geom を結合（チャンク + 2分木）。
 * pcUnion の戻りは常に MultiPolygon。
 */
export function unionPcGeoms(geoms: PcGeom[]): PcMultiPolygon | null {
  if (geoms.length === 0) return null;
  if (geoms.length === 1) return asMultiPolygon(geoms[0]!);

  try {
    let acc: PcMultiPolygon[] = [];
    for (let i = 0; i < geoms.length; i += PC_UNION_CHUNK) {
      const chunk = geoms.slice(i, i + PC_UNION_CHUNK);
      const first = chunk[0]!;
      const merged =
        chunk.length === 1
          ? asMultiPolygon(first)
          : activePcUnion(first, ...chunk.slice(1));
      acc.push(merged);
    }
    while (acc.length > 1) {
      const next: PcMultiPolygon[] = [];
      for (let i = 0; i < acc.length; i += 2) {
        if (i + 1 >= acc.length) {
          next.push(acc[i]!);
        } else {
          next.push(activePcUnion(acc[i]!, acc[i + 1]!));
        }
      }
      acc = next;
    }
    return acc[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * 結果が各入力と少なくとも交差するか。
 * 完全消失の検知のみ（部分欠落・面積ロスは検出しない）。
 *
 * まず葉ポリゴン外殻の頂点で point-in-polygon（境界含む）を試し、
 * それでも外れたときだけ booleanIntersects に落とす。
 * dense タイルでは intersects 全件が数百 ms になり得るため。
 */
function polygonPartsAsFeatures(result: PolyFeature): Feature<Polygon>[] {
  if (result.geometry.type === "Polygon") {
    return [result as Feature<Polygon>];
  }
  return result.geometry.coordinates.map((coordinates) => ({
    type: "Feature" as const,
    properties: {},
    geometry: { type: "Polygon" as const, coordinates },
  }));
}

/** 外殻から PIP 用の候補頂点（最大 3）。薄いバッファでは ring 平均は外に出やすい。 */
function coverageProbeCoords(input: Feature<Polygon>): Position[] {
  const ring = input.geometry.coordinates[0];
  if (!ring || ring.length < 2) return [];
  const last = ring.length - 1;
  const picks = [0, Math.min(1, last - 1), Math.min(2, last - 1)];
  const out: Position[] = [];
  const seen = new Set<string>();
  for (const i of picks) {
    const c = ring[i]!;
    const key = `${c[0]},${c[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function inputCoveredByParts(
  input: Feature<Polygon>,
  parts: Feature<Polygon>[],
  partBoxes: BBox4[]
): boolean {
  const inputBox = featureBbox(input);
  const probes = coverageProbeCoords(input);

  for (const coord of probes) {
    const pt = point(coord);
    for (let i = 0; i < parts.length; i++) {
      if (!bboxesOverlap(inputBox, partBoxes[i]!)) continue;
      try {
        if (booleanPointInPolygon(pt, parts[i]!, { ignoreBoundary: false })) {
          return true;
        }
      } catch {
        // PIP 失敗時は intersects へ
      }
    }
  }

  for (let i = 0; i < parts.length; i++) {
    if (!bboxesOverlap(inputBox, partBoxes[i]!)) continue;
    try {
      if (booleanIntersects(input as never, parts[i]! as never)) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

export function uncoveredInputs(
  result: PolyFeature,
  inputs: Feature<Polygon>[]
): Feature<Polygon>[] {
  const parts = polygonPartsAsFeatures(result);
  const partBoxes = parts.map((p) => featureBbox(p));
  const missing: Feature<Polygon>[] = [];

  for (const input of inputs) {
    if (!inputCoveredByParts(input, parts, partBoxes)) {
      missing.push(input);
    }
  }
  return missing;
}

export function unionResultTouchesAllInputs(
  result: PolyFeature,
  inputs: Feature<Polygon>[]
): boolean {
  return uncoveredInputs(result, inputs).length === 0;
}

export function tryPcUnionLeaves(
  leaves: Feature<Polygon>[]
): PolyFeature | null {
  if (leaves.length === 0) return null;
  if (leaves.length === 1) return leaves[0] ?? null;

  const sorted = sortSpatially(leaves);
  const geoms = sorted.map((f) => toPcGeoms(f));
  const result = unionPcGeoms(geoms);
  if (!result || result.length === 0) return null;
  return fromPcMultiPolygon(result);
}

export function tryPcMergeFeatures(
  a: PolyFeature,
  b: PolyFeature
): PolyFeature | null {
  try {
    const merged = activePcUnion(toPcGeoms(a), toPcGeoms(b));
    if (!merged || merged.length === 0) return null;
    return fromPcMultiPolygon(merged);
  } catch {
    return null;
  }
}
