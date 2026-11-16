/**
 * 道路面ポリゴンを表示用 bbox にクリップする（M2 / Tile API 結果クリップ）。
 *
 * turf bboxClip は、bbox 外でのみ繋がる複数ローブを
 * クリップ辺上の長辺で 1 ポリゴンに閉じることがある。
 * その辺が非道路の「挟まれ帯」を横切るとタイル輪郭の細い地物になる。
 * polygon-clipping の intersection ならローブが分離される。
 */
import polygonClipping from "polygon-clipping";
import type { Feature, Polygon, Position } from "geojson";
import type { Bbox } from "./types.js";

type PcRing = [number, number][];
type PcPolygon = PcRing[];
type PcMultiPolygon = PcPolygon[];

function toPcPolygon(coords: Position[][]): PcPolygon {
  return coords.map((ring) =>
    ring.map((p) => [p[0]!, p[1]!] as [number, number])
  );
}

function bboxToPcPolygon(clipBbox: Bbox): PcPolygon {
  const [west, south, east, north] = clipBbox;
  return [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ];
}

function ringFullyInsideBbox(
  ring: Position[],
  clipBbox: Bbox,
  eps = 1e-12
): boolean {
  const [west, south, east, north] = clipBbox;
  for (const c of ring) {
    const lon = c[0]!;
    const lat = c[1]!;
    if (
      lon < west - eps ||
      lon > east + eps ||
      lat < south - eps ||
      lat > north + eps
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 頂点がすべて bbox 内ならそのまま返す（再 PC しない）。
 * はみ出しがある feature だけ intersection する。
 * Tile API の防御的クリップ向け（core が既に clipToBbox 済みならほぼ no-op）。
 */
export function clipPolygonsToBboxIfNeeded(
  polygons: Feature<Polygon>[],
  clipBbox: Bbox
): Feature<Polygon>[] {
  const needsClip: Feature<Polygon>[] = [];
  const kept: Feature<Polygon>[] = [];
  for (const feature of polygons) {
    const ring = feature.geometry.coordinates[0] ?? [];
    if (ring.length >= 4 && ringFullyInsideBbox(ring, clipBbox)) {
      kept.push(feature);
    } else {
      needsClip.push(feature);
    }
  }
  if (needsClip.length === 0) return kept;
  return [...kept, ...clipPolygonsToBbox(needsClip, clipBbox)];
}

function fromPcMultiPolygon(
  coords: PcMultiPolygon,
  properties: Feature<Polygon>["properties"]
): Feature<Polygon>[] {
  const out: Feature<Polygon>[] = [];
  for (const poly of coords) {
    if (!poly[0] || poly[0].length < 4) continue;
    out.push({
      type: "Feature",
      properties: { ...(properties ?? {}) },
      geometry: {
        type: "Polygon",
        coordinates: poly.map((ring) => ring.map((p) => [p[0], p[1]])),
      },
    });
  }
  return out;
}

/**
 * 各ポリゴンを bbox で厳密クリップし、Polygon のみ返す。
 * bbox 外接続だけのローブは別 Polygon に分割する。
 * クリップで消えた・無効なものは落とす。
 */
export function clipPolygonsToBbox(
  polygons: Feature<Polygon>[],
  clipBbox: Bbox
): Feature<Polygon>[] {
  const clipPoly = bboxToPcPolygon(clipBbox);
  const out: Feature<Polygon>[] = [];

  for (const feature of polygons) {
    try {
      const subject: PcMultiPolygon = [
        toPcPolygon(feature.geometry.coordinates),
      ];
      const clipped = polygonClipping.intersection(subject, [clipPoly]);
      if (!clipped || clipped.length === 0) continue;

      for (const part of fromPcMultiPolygon(clipped, feature.properties)) {
        if (part.geometry.coordinates[0]?.length >= 4) {
          out.push(part);
        }
      }
    } catch {
      /* skip invalid */
    }
  }

  return out;
}
