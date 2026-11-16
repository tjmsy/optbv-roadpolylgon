/**
 * 0.2 m バッファで道路＋街区が同一セルになったあふれを、
 * 中庭判定で落としたあと 0.5 m 差分から道路片だけ復元する。
 */
import booleanIntersects from "@turf/boolean-intersects";
import buffer from "@turf/buffer";
import flatten from "@turf/flatten";
import { featureCollection, polygon } from "@turf/helpers";
import type { Feature, Polygon } from "geojson";
import { bboxToPolygonRing } from "./bbox.js";
import { bufferEdgeFeatures } from "./buffer-edges.js";
import {
  hasBlockCourtyardInterior,
  intersectingCenterlines,
  majorityVerticesWithinCenterlineDistance,
  MAX_ROAD_VERTEX_TO_CL_DIST_M,
} from "./centerline-distance.js";
import { clipPolygonsToBbox } from "./clip-polygons.js";
import { differencePolygonsDetailed } from "./difference-polygons.js";
import { BBoxIndex } from "./spatial-index.js";
import { unionAllPolygonsDetailed } from "./union-polygons.js";
import type { Bbox, LineFeature } from "./types.js";

/** 細い開口を塞ぐための段階バッファ（m）。0.2 m では分離しない neck 向け */
export const COURTYARD_SPILL_ESCALATE_BUFFER_M = 0.5;
/** 0.5 m 分離で痩せた道路片の厚みを戻す再太化量（m） */
export const COURTYARD_SPILL_RESTORE_BUFFER_M = 0.5;

function restoreRoadPieceThickness(
  piece: Feature<Polygon>,
  workBbox: Bbox,
  restoreBufferM: number
): Feature<Polygon>[] {
  try {
    const buffered = buffer(piece, restoreBufferM, { units: "meters" });
    if (!buffered) return [];
    const expanded =
      buffered.geometry.type === "Polygon"
        ? [buffered as Feature<Polygon>]
        : flatten(featureCollection([buffered])).features.filter(
            (f): f is Feature<Polygon> => f.geometry.type === "Polygon"
          );
    if (expanded.length === 0) return [];
    return clipPolygonsToBbox(expanded, workBbox);
  } catch {
    return [];
  }
}

export function recoverRoadPiecesAfterCourtyardSpill(
  spillFeature: Feature<Polygon>,
  edges: LineFeature[],
  workBbox: Bbox,
  clIndex: BBoxIndex<LineFeature>,
  escalateBufferM: number = COURTYARD_SPILL_ESCALATE_BUFFER_M,
  restoreBufferM: number = COURTYARD_SPILL_RESTORE_BUFFER_M,
  edgeIndex?: BBoxIndex<LineFeature>
): Feature<Polygon>[] {
  const { polygons } = bufferEdgeFeatures(edges, {
    distanceMeters: escalateBufferM,
  });
  const skipped = { count: 0 };
  const union = unionAllPolygonsDetailed(polygons, skipped);
  if (!union.feature) return [];

  const diff = differencePolygonsDetailed(
    polygon([bboxToPolygonRing(workBbox)]),
    union.feature
  );
  if (!diff.feature) return [];

  const splits = flatten(featureCollection([diff.feature])).features.filter(
    (f): f is Feature<Polygon> => f.geometry.type === "Polygon"
  );

  const sharedEdgeIndex = edgeIndex ?? BBoxIndex.fromLineFeatures(edges);
  const recovered: Feature<Polygon>[] = [];
  for (const piece of splits) {
    if (!booleanIntersects(piece, spillFeature)) continue;

    const hitting = intersectingCenterlines(piece, clIndex);
    if (hitting.length === 0) continue;

    const distCheck = majorityVerticesWithinCenterlineDistance(
      piece,
      hitting,
      MAX_ROAD_VERTEX_TO_CL_DIST_M
    );
    if (!distCheck.ok) continue;
    if (
      hasBlockCourtyardInterior(
        piece,
        hitting,
        edges,
        MAX_ROAD_VERTEX_TO_CL_DIST_M,
        undefined,
        undefined,
        sharedEdgeIndex
      )
    ) {
      continue;
    }

    const restored = restoreRoadPieceThickness(piece, workBbox, restoreBufferM);
    for (const candidate of restored) {
      const restoredHits = intersectingCenterlines(candidate, clIndex);
      if (restoredHits.length === 0) continue;
      const restoredDist = majorityVerticesWithinCenterlineDistance(
        candidate,
        restoredHits,
        MAX_ROAD_VERTEX_TO_CL_DIST_M
      );
      if (!restoredDist.ok) continue;
      if (
        hasBlockCourtyardInterior(
          candidate,
          restoredHits,
          edges,
          MAX_ROAD_VERTEX_TO_CL_DIST_M,
          undefined,
          undefined,
          sharedEdgeIndex
        )
      ) {
        continue;
      }
      recovered.push(candidate);
    }
  }
  return recovered;
}
