import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import type { Feature, Point, Polygon, Position } from "geojson";
import {
  listDanglingOpeningTips,
  type DanglingOpeningTip,
} from "./edge-gap-dangling.js";
import {
  haversineMeters,
  metersPerDegreeLongitude,
  METERS_PER_DEGREE_LATITUDE_BBOX,
} from "./geodesy.js";
import type { Bbox, LineFeature, RoadSurfaceFailure } from "./types.js";
import { BBoxIndex } from "./spatial-index.js";

/** bbox 境界からこの距離以内の線端はビュー外開口として無視（m） */
export const SPILL_BBOX_MARGIN_M = 3;
/** 線端から縁に沿って内側へ下がる距離（m）。端点まわりの回り込みを避ける */
export const SPILL_SAMPLE_INSET_M = 3;
/** 縁の左右へオフセットする距離（m）。縁バッファより外側のセル側 */
export const SPILL_SIDE_OFFSET_M = 2;

export interface SpillEdgeSidesDiagnostics {
  /** 内陸ダングリング線端が 0 のため左右チェックを省略 */
  skipped: boolean;
  interiorDanglingTips: number;
  checkedTips: number;
  bothSidesHits: number;
}

export interface SpillEdgeSidesHit {
  tip: DanglingOpeningTip;
  left: Position;
  right: Position;
}

export interface SpillEdgeSidesResult {
  ok: boolean;
  diagnostics: SpillEdgeSidesDiagnostics;
  hits: SpillEdgeSidesHit[];
  failure?: RoadSurfaceFailure;
}

/** Result shape used when the caller explicitly skips the spill quality check. */
export function skippedSpillEdgeSidesResult(): SpillEdgeSidesResult {
  return {
    ok: true,
    diagnostics: {
      skipped: true,
      interiorDanglingTips: 0,
      checkedTips: 0,
      bothSidesHits: 0,
    },
    hits: [],
  };
}

/** 点から bbox 境界までの最短距離（m） */
export function distanceToBboxBoundaryM(
  lon: number,
  lat: number,
  bbox: Bbox
): number {
  const [west, south, east, north] = bbox;
  const toWest = haversineMeters(lon, lat, west, lat);
  const toEast = haversineMeters(lon, lat, east, lat);
  const toSouth = haversineMeters(lon, lat, lon, south);
  const toNorth = haversineMeters(lon, lat, lon, north);
  return Math.min(toWest, toEast, toSouth, toNorth);
}

export function isInteriorToBbox(
  lon: number,
  lat: number,
  bbox: Bbox,
  marginM = SPILL_BBOX_MARGIN_M
): boolean {
  const [west, south, east, north] = bbox;
  if (lon < west || lon > east || lat < south || lat > north) return false;
  return distanceToBboxBoundaryM(lon, lat, bbox) > marginM;
}

/** 方位・距離で点を移動（局所平面近似） */
export function offsetByBearingMeters(
  lon: number,
  lat: number,
  bearingDeg: number,
  distanceM: number
): Position {
  const br = (bearingDeg * Math.PI) / 180;
  const dLat = (distanceM * Math.cos(br)) / METERS_PER_DEGREE_LATITUDE_BBOX;
  const dLon = (distanceM * Math.sin(br)) / metersPerDegreeLongitude(lat);
  return [lon + dLon, lat + dLat];
}

function pointInAnyRoad(
  coord: Position,
  roads: Feature<Polygon>[],
  roadIndex?: BBoxIndex<Feature<Polygon>>
): boolean {
  const pt = point(coord);
  const candidates = roadIndex
    ? roadIndex.searchPoint(coord[0]!, coord[1]!)
    : roads;
  for (const road of candidates) {
    try {
      if (booleanPointInPolygon(pt, road)) return true;
    } catch {
      /* skip invalid */
    }
  }
  return false;
}

/**
 * ビュー内に塞げなかった縁線端があるときだけ、その近傍で縁の左右が
 * ともに道路面ならあふれ NG。線端が無ければチェック省略。
 *
 * @param edges ギャップ橋渡し後の縁（bridges 含む）
 * @param roadPolygons 最終道路面
 * @param bbox 表示／判定 bbox（viewport）
 */
export function evaluateSpillByEdgeSides(
  edges: LineFeature[],
  roadPolygons: Feature<Polygon>[],
  bbox: Bbox,
  options?: {
    bboxMarginM?: number;
    sampleInsetM?: number;
    sideOffsetM?: number;
    /** 事前計算済みのダングリング線端。未指定時は edges から算出。 */
    danglingTips?: DanglingOpeningTip[];
  }
): SpillEdgeSidesResult {
  const bboxMarginM = options?.bboxMarginM ?? SPILL_BBOX_MARGIN_M;
  const sampleInsetM = options?.sampleInsetM ?? SPILL_SAMPLE_INSET_M;
  const sideOffsetM = options?.sideOffsetM ?? SPILL_SIDE_OFFSET_M;

  const allTips = options?.danglingTips ?? listDanglingOpeningTips(edges);
  const interiorTips = allTips.filter((tip) =>
    isInteriorToBbox(tip.coord[0]!, tip.coord[1]!, bbox, bboxMarginM)
  );

  if (interiorTips.length === 0) {
    return {
      ok: true,
      diagnostics: {
        skipped: true,
        interiorDanglingTips: 0,
        checkedTips: 0,
        bothSidesHits: 0,
      },
      hits: [],
    };
  }

  const hits: SpillEdgeSidesHit[] = [];
  const roadIndex = BBoxIndex.fromPolygons(roadPolygons);
  for (const tip of interiorTips) {
    const along = offsetByBearingMeters(
      tip.coord[0]!,
      tip.coord[1]!,
      tip.inwardBearing,
      sampleInsetM
    );
    const left = offsetByBearingMeters(
      along[0]!,
      along[1]!,
      tip.inwardBearing - 90,
      sideOffsetM
    );
    const right = offsetByBearingMeters(
      along[0]!,
      along[1]!,
      tip.inwardBearing + 90,
      sideOffsetM
    );
    const leftIn = pointInAnyRoad(left, roadPolygons, roadIndex);
    const rightIn = pointInAnyRoad(right, roadPolygons, roadIndex);
    if (leftIn && rightIn) {
      hits.push({ tip, left, right });
    }
  }

  const diagnostics: SpillEdgeSidesDiagnostics = {
    skipped: false,
    interiorDanglingTips: interiorTips.length,
    checkedTips: interiorTips.length,
    bothSidesHits: hits.length,
  };

  if (hits.length === 0) {
    return { ok: true, diagnostics, hits };
  }

  const failure: RoadSurfaceFailure = {
    code: "spill-edge-sides",
    message:
      "ビュー内に未閉鎖の道路縁線端があり、その近傍で縁の左右がともに道路面です。ギャップ未閉鎖または信頼境バリア不足によるあふれが疑われます。",
    interiorDanglingTips: interiorTips.length,
    bothSidesHits: hits.length,
  };

  return { ok: false, diagnostics, hits, failure };
}

/**
 * ギャップ橋渡し後も残るダングリング線端を Point 中間生成物にする。
 */
export function buildDanglingTipFeatures(
  edges: LineFeature[],
  bbox: Bbox,
  spillHits: SpillEdgeSidesHit[] = [],
  options?: {
    bboxMarginM?: number;
    /** 事前計算済みのダングリング線端。未指定時は edges から算出。 */
    danglingTips?: DanglingOpeningTip[];
  }
): Feature<Point>[] {
  const bboxMarginM = options?.bboxMarginM ?? SPILL_BBOX_MARGIN_M;
  const hitKeys = new Set(
    spillHits.map((h) => `${h.tip.edgeIndex}:${h.tip.end}`)
  );
  const tips = options?.danglingTips ?? listDanglingOpeningTips(edges);
  return tips.map((tip) => {
    const lon = tip.coord[0]!;
    const lat = tip.coord[1]!;
    const interior = isInteriorToBbox(lon, lat, bbox, bboxMarginM);
    const bothSidesHit = hitKeys.has(`${tip.edgeIndex}:${tip.end}`);
    return {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [lon, lat] },
      properties: {
        edgeIndex: tip.edgeIndex,
        end: tip.end,
        inwardBearing: Math.round(tip.inwardBearing * 10) / 10,
        interior,
        bothSidesHit,
        lon: Math.round(lon * 1e6) / 1e6,
        lat: Math.round(lat * 1e6) / 1e6,
      },
    };
  });
}

/** デバッグ／検査用（未使用でも bearing 整合の確認に） */
export function sampleSidePointsForTip(
  tip: DanglingOpeningTip,
  sampleInsetM = SPILL_SAMPLE_INSET_M,
  sideOffsetM = SPILL_SIDE_OFFSET_M
): { along: Position; left: Position; right: Position } {
  const along = offsetByBearingMeters(
    tip.coord[0]!,
    tip.coord[1]!,
    tip.inwardBearing,
    sampleInsetM
  );
  return {
    along,
    left: offsetByBearingMeters(
      along[0]!,
      along[1]!,
      tip.inwardBearing - 90,
      sideOffsetM
    ),
    right: offsetByBearingMeters(
      along[0]!,
      along[1]!,
      tip.inwardBearing + 90,
      sideOffsetM
    ),
  };
}
