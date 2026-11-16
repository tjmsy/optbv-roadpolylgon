import type { Bbox } from "./types.js";
import {
  metersToBboxDegreePads,
  METERS_PER_DEGREE_LATITUDE_BBOX,
  metersPerDegreeLongitude,
} from "./geodesy.js";

export function bboxCentroid(bbox: Bbox): [lon: number, lat: number] {
  const [west, south, east, north] = bbox;
  return [(west + east) / 2, (south + north) / 2];
}

export function bboxToPolygonRing(bbox: Bbox): [number, number][] {
  const [west, south, east, north] = bbox;
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

/** MapLibre LngLatBoundsLike / getBounds() 形式から Bbox へ */
export function boundsToBbox(bounds: {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
}): Bbox {
  return [
    bounds.getWest(),
    bounds.getSouth(),
    bounds.getEast(),
    bounds.getNorth(),
  ];
}

/**
 * bbox を各辺へ fraction 分だけ広げる（viewport 余裕用）。
 * fraction=0.1 → 幅・高さそれぞれ約 10% ずつ外側へ。
 */
export function padBbox(bbox: Bbox, fraction = 0.1): Bbox {
  const [west, south, east, north] = bbox;
  const padX = ((east - west) * fraction) / 2;
  const padY = ((north - south) * fraction) / 2;
  return [west - padX, south - padY, east + padX, north + padY];
}

/**
 * bbox を各辺へ指定メートルだけ広げる。Tile API のように、ズームに依らない
 * 入力コンテキスト（halo）が必要な場合に使う。
 */
export function padBboxMeters(bbox: Bbox, meters: number): Bbox {
  if (!Number.isFinite(meters) || meters < 0) {
    throw new RangeError("meters must be a finite non-negative number");
  }
  const [west, south, east, north] = bbox;
  const latMid = (south + north) / 2;
  const { longitude, latitude } = metersToBboxDegreePads(meters, latMid);
  return [
    west - longitude,
    south - latitude,
    east + longitude,
    north + latitude,
  ];
}

/** bbox の概算面積 (m²)。suspect 判定の占有率などに使う */
export function bboxAreaM2(bbox: Bbox): number {
  const [west, south, east, north] = bbox;
  const latMid = (south + north) / 2;
  const widthM = (east - west) * metersPerDegreeLongitude(latMid);
  const heightM = (north - south) * METERS_PER_DEGREE_LATITUDE_BBOX;
  return Math.max(0, widthM * heightM);
}
