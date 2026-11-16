import type { Feature, Polygon } from "geojson";
import type { LineFeature } from "./types.js";
import {
  BBoxIndex,
  lineFeatureBBox,
  polygonFeatureBBox,
  type BBox4,
} from "./spatial-index.js";
import { lineIntersectsPolygon } from "./line-polygon-intersect.js";
function resolveClCandidates(
  featureBbox: BBox4,
  centerlines: LineFeature[] | BBoxIndex<LineFeature>
): LineFeature[] {
  if (centerlines instanceof BBoxIndex) {
    return centerlines.search(featureBbox);
  }
  return centerlines;
}

/**
 * ポリゴンと交わる centerlines のみを返す。
 * `BBoxIndex` を渡すと bbox 剪定してから局所交差判定する。
 */
export function intersectingCenterlines(
  feature: Feature<Polygon>,
  centerlines: LineFeature[] | BBoxIndex<LineFeature>
): LineFeature[] {
  const fb = polygonFeatureBBox(feature);
  const candidates = resolveClCandidates(fb, centerlines);
  if (candidates.length === 0) return [];

  // 配列渡しのときも bbox で一次剪定
  const pruned =
    centerlines instanceof BBoxIndex
      ? candidates
      : candidates.filter((cl) => {
          const lb = lineFeatureBBox(cl);
          return !(
            fb[2] < lb[0] ||
            lb[2] < fb[0] ||
            fb[3] < lb[1] ||
            lb[3] < fb[1]
          );
        });

  return pruned.filter((cl) => {
    try {
      return lineIntersectsPolygon(cl, feature);
    } catch {
      return false;
    }
  });
}
