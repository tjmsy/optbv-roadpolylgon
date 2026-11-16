import type { Feature, Polygon } from "geojson";
import {
  hasBlockCourtyardInterior,
  intersectingCenterlines,
  majorityVerticesWithinCenterlineDistance,
  MAX_ROAD_VERTEX_TO_CL_DIST_M,
} from "./centerline-distance.js";
import { recoverRoadPiecesAfterCourtyardSpill } from "./courtyard-spill-recovery.js";
import { BBoxIndex } from "./spatial-index.js";
import type { Bbox, LineFeature } from "./types.js";

export type RoadPolygonSelectionResult = {
  polygons: Feature<Polygon>[];
  safeHitsByPolygon: LineFeature[][];
  prunedFarFromCenterline: number;
  prunedCourtyardInterior: number;
};

/** Keep split regions supported by trusted centerlines and recover courtyard spill. */
export function selectRoadPolygons(
  splitPolygons: Feature<Polygon>[],
  centerlines: LineFeature[],
  edges: LineFeature[],
  bbox: Bbox,
  simpleSelection: boolean,
  skipped: { count: number }
): RoadPolygonSelectionResult {
  const polygons: Feature<Polygon>[] = [];
  const safeHitsByPolygon: LineFeature[][] = [];
  let prunedFarFromCenterline = 0;
  let prunedCourtyardInterior = 0;
  const safeClIndex = BBoxIndex.fromLineFeatures(centerlines);
  const edgeIndex = simpleSelection
    ? undefined
    : BBoxIndex.fromLineFeatures(edges);

  for (const feature of splitPolygons) {
    try {
      const hitting = intersectingCenterlines(feature, safeClIndex);
      if (hitting.length === 0) continue;

      if (!simpleSelection) {
        const distCheck = majorityVerticesWithinCenterlineDistance(
          feature,
          hitting,
          MAX_ROAD_VERTEX_TO_CL_DIST_M
        );
        if (!distCheck.ok) {
          prunedFarFromCenterline++;
          continue;
        }

        if (
          hasBlockCourtyardInterior(
            feature,
            hitting,
            edges,
            MAX_ROAD_VERTEX_TO_CL_DIST_M,
            undefined,
            undefined,
            edgeIndex
          )
        ) {
          prunedCourtyardInterior++;
          const recovered = recoverRoadPiecesAfterCourtyardSpill(
            feature,
            edges,
            bbox,
            safeClIndex,
            undefined,
            undefined,
            edgeIndex
          );
          for (const recoveredFeature of recovered) {
            polygons.push(recoveredFeature);
            safeHitsByPolygon.push(
              intersectingCenterlines(recoveredFeature, safeClIndex)
            );
          }
          continue;
        }
      }

      polygons.push(feature);
      safeHitsByPolygon.push(hitting);
    } catch {
      skipped.count++;
    }
  }

  return {
    polygons,
    safeHitsByPolygon,
    prunedFarFromCenterline,
    prunedCourtyardInterior,
  };
}
