/**
 * subject − subtract。polygon-clipping 優先、失敗時 Turf、
 * それでも失敗したら MultiPolygon を部品ごとに差し引く。
 *
 * union の pc-recursive / concat フォールバックは重なり得る部品を
 * MultiPolygon 連結し得るため、一括 difference が
 * "Unable to complete output ring" で落ちることがある。
 */
import difference from "@turf/difference";
import bbox from "@turf/bbox";
import { featureCollection } from "@turf/helpers";
import polygonClipping from "polygon-clipping";
import type { Feature, Polygon } from "geojson";
import {
  asPolygonClippingMultiPolygon,
  fromPolygonClippingMultiPolygon,
  toPolygonClippingGeometry,
  type PolyFeature,
} from "./difference-geometry.js";

type BBox4 = [number, number, number, number];

const pcDifference = polygonClipping.difference;
const BBOX_PAD_DEG = 1e-7;

function featureBbox(f: PolyFeature): BBox4 {
  return bbox(f) as BBox4;
}

function bboxesOverlap(a: BBox4, b: BBox4, pad = BBOX_PAD_DEG): boolean {
  return !(
    a[2] + pad < b[0] ||
    b[2] + pad < a[0] ||
    a[3] + pad < b[1] ||
    b[3] + pad < a[1]
  );
}

/**
 * subject と重ならない subtract 部品を落とす。
 * bbox − buffer では外のバッファは結果に影響しない。
 */
export function pruneSubtractToSubject(
  subject: PolyFeature,
  subtract: PolyFeature
): PolyFeature | null {
  const subjBox = featureBbox(subject);
  if (subtract.geometry.type === "Polygon") {
    return bboxesOverlap(subjBox, featureBbox(subtract)) ? subtract : null;
  }
  const kept = subtract.geometry.coordinates.filter((coordinates) =>
    bboxesOverlap(subjBox, bbox({ type: "Polygon", coordinates }) as BBox4)
  );
  if (kept.length === 0) return null;
  if (kept.length === subtract.geometry.coordinates.length) return subtract;
  if (kept.length === 1) {
    return {
      type: "Feature",
      properties: subtract.properties ?? {},
      geometry: { type: "Polygon", coordinates: kept[0]! },
    };
  }
  return {
    type: "Feature",
    properties: subtract.properties ?? {},
    geometry: { type: "MultiPolygon", coordinates: kept },
  };
}

export type DifferenceOptions = {
  /**
   * union が dirty concat MultiPolygon のとき true。
   * 一括 PC はほぼ必ず例外になるので省略して Turf/iterative へ進む。
   */
  skipPolygonClipping?: boolean;
};

/** MultiPolygon / Polygon を部品 Polygon に分解する。 */
export function polygonParts(feature: PolyFeature): Feature<Polygon>[] {
  if (feature.geometry.type === "Polygon") {
    return [feature as Feature<Polygon>];
  }
  return feature.geometry.coordinates.map((coordinates) => ({
    type: "Feature" as const,
    properties: feature.properties ?? {},
    geometry: { type: "Polygon" as const, coordinates },
  }));
}

export type DifferenceStrategy = "polygon-clipping" | "turf" | "iterative";

export type DifferenceAllResult = {
  feature: PolyFeature | null;
  strategy: DifferenceStrategy;
};

function differenceWithTurf(
  subject: PolyFeature,
  subtract: PolyFeature
): PolyFeature | null {
  try {
    const result = difference(featureCollection([subject, subtract]));
    if (
      result?.geometry.type === "Polygon" ||
      result?.geometry.type === "MultiPolygon"
    ) {
      return result as PolyFeature;
    }
    return null;
  } catch {
    return null;
  }
}

function differenceOnePc(
  subject: PolyFeature,
  subtract: PolyFeature
): { feature: PolyFeature | null; empty: boolean; threw: boolean } {
  try {
    const subj = asPolygonClippingMultiPolygon(
      toPolygonClippingGeometry(subject)
    );
    const clip = asPolygonClippingMultiPolygon(
      toPolygonClippingGeometry(subtract)
    );
    const result = pcDifference(subj, clip);
    if (result && result.length > 0) {
      return {
        feature: fromPolygonClippingMultiPolygon(result),
        empty: false,
        threw: false,
      };
    }
    if (Array.isArray(result) && result.length === 0) {
      return { feature: null, empty: true, threw: false };
    }
    return { feature: null, empty: false, threw: false };
  } catch {
    return { feature: null, empty: false, threw: true };
  }
}

/**
 * 重なり得る MultiPolygon 部品を 1 つずつ差し引く。
 * 一括 PC/Turf がトポロジ例外で落ちる場合の回復経路。
 *
 * 部品単位で PC/Turf 両方失敗したらその部品はスキップする
 * （マスク欠けは残るが、全面失敗で道路面ゼロになるよりマシ）。
 */
function differenceIterative(
  subject: PolyFeature,
  subtract: PolyFeature
): PolyFeature | null {
  const parts = polygonParts(subtract);
  if (parts.length === 0) {
    return subject;
  }

  let current: PolyFeature | null = subject;
  let subtracted = 0;
  for (const part of parts) {
    if (!current) return null;

    const pc = differenceOnePc(current, part);
    if (pc.empty) return null;
    if (pc.feature) {
      current = pc.feature;
      subtracted++;
      continue;
    }

    const turfResult = differenceWithTurf(current, part);
    if (turfResult) {
      current = turfResult;
      subtracted++;
      continue;
    }

    // PC が空差を返さず Turf も失敗 → 覆いとは限らないのでスキップ。
  }

  // 一度も差し引けなければ回復失敗（呼び出し側は null と同等に扱う）。
  if (subtracted === 0 && parts.length > 0) {
    return null;
  }
  return current;
}

/**
 * subject から subtract を差し引く。
 * 1) polygon-clipping 一括 2) Turf 一括 3) 部品ごと（iterative）
 */
export function differencePolygonsDetailed(
  subject: PolyFeature,
  subtract: PolyFeature,
  options: DifferenceOptions = {}
): DifferenceAllResult {
  const pruned = pruneSubtractToSubject(subject, subtract);
  if (!pruned) {
    return { feature: subject, strategy: "polygon-clipping" };
  }

  if (!options.skipPolygonClipping) {
    const pc = differenceOnePc(subject, pruned);
    if (pc.empty) {
      return { feature: null, strategy: "polygon-clipping" };
    }
    if (pc.feature) {
      return { feature: pc.feature, strategy: "polygon-clipping" };
    }
  }

  const turfFeature = differenceWithTurf(subject, pruned);
  if (turfFeature) {
    return { feature: turfFeature, strategy: "turf" };
  }

  // 一括失敗時は部品差で回復。空差（全面マスク）も iterative が null を返す。
  if (polygonParts(pruned).length >= 1) {
    return {
      feature: differenceIterative(subject, pruned),
      strategy: "iterative",
    };
  }

  return { feature: null, strategy: "turf" };
}

export function differencePolygons(
  subject: PolyFeature,
  subtract: PolyFeature,
  options: DifferenceOptions = {}
): PolyFeature | null {
  return differencePolygonsDetailed(subject, subtract, options).feature;
}
