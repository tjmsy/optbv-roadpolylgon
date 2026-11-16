/**
 * 道路面ポリゴンへ交差する RdCL 属性を引き継ぐ（M3.3）。
 */
import type { Feature, Polygon, Position } from "geojson";
import type { LineFeature } from "./types.js";
import { localVectorMeters } from "./geodesy.js";
import { BBoxIndex } from "./spatial-index.js";
import { intersectingCenterlines } from "./centerline-distance.js";

/** 道路面へコピーする RdCL 属性キー */
export const INHERITED_CL_ATTR_KEYS = [
  "vt_rdctg",
  "vt_rnkwidth",
  "vt_code",
  "vt_motorway",
] as const;

export type InheritedClAttrKey = (typeof INHERITED_CL_ATTR_KEYS)[number];

/** 属性選定用の粗い長さ（m） */
function approxLengthMeters(coords: Position[]): number {
  let sum = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i]!;
    const b = coords[i + 1]!;
    const [dx, dy] = localVectorMeters(a, b);
    sum += Math.hypot(dx, dy);
  }
  return sum;
}

function pickPrimaryCenterline(hitting: LineFeature[]): LineFeature | null {
  let best: LineFeature | null = null;
  let bestLen = -1;
  for (const cl of hitting) {
    const lenM = approxLengthMeters(cl.geometry.coordinates);
    if (lenM > bestLen) {
      bestLen = lenM;
      best = cl;
    }
  }
  return best;
}

function copyClAttributes(
  from: LineFeature
): Record<string, string | number | boolean | null> {
  const props = from.properties ?? {};
  const out: Record<string, string | number | boolean | null> = {};
  for (const key of INHERITED_CL_ATTR_KEYS) {
    const v = props[key];
    if (v === undefined || v === null) continue;
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[key] = v;
    } else {
      out[key] = String(v);
    }
  }
  return out;
}

function withClAttributes(
  feature: Feature<Polygon>,
  hitting: LineFeature[]
): Feature<Polygon> {
  const primary = pickPrimaryCenterline(hitting);
  if (!primary) return feature;
  const inherited = copyClAttributes(primary);
  if (Object.keys(inherited).length === 0) {
    return {
      ...feature,
      properties: {
        ...(feature.properties ?? {}),
        _attrFromCl: true,
      },
    };
  }
  return {
    ...feature,
    properties: {
      ...(feature.properties ?? {}),
      ...inherited,
      _attrFromCl: true,
    },
  };
}

/**
 * 各道路面に、交差する RdCL のうち最長の属性を付与する。
 *
 * @param knownSafeHits filter で得た safe CL 交差（polygons と同順）。
 *   渡すと safe の再交差を省略し、`extraCenterlines`（通常は provisional）だけ追加検索する。
 */
export function attachCenterlineAttributes(
  polygons: Feature<Polygon>[],
  centerlines: LineFeature[],
  options?: {
    knownSafeHits?: LineFeature[][];
    extraCenterlines?: LineFeature[];
  }
): Feature<Polygon>[] {
  const known = options?.knownSafeHits;
  const extra = options?.extraCenterlines ?? centerlines;
  if (!known && centerlines.length === 0) return polygons;

  const extraIndex =
    extra.length > 0 ? BBoxIndex.fromLineFeatures(extra) : null;

  return polygons.map((feature, i) => {
    const prior = known?.[i] ?? [];
    const more = extraIndex
      ? intersectingCenterlines(feature, extraIndex)
      : known
        ? []
        : intersectingCenterlines(
            feature,
            BBoxIndex.fromLineFeatures(centerlines)
          );
    const hitting = prior.length === 0 ? more : [...prior, ...more];
    return withClAttributes(feature, hitting);
  });
}
