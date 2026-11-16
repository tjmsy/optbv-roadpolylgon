import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { Feature, Polygon, Position } from "geojson";
import type { LineFeature } from "./types.js";
import { BBoxIndex } from "./spatial-index.js";
import {
  M_PER_DEG_LAT,
  metersPerDegLon,
  minDistToLinesM,
  minDistToLinesWithinThresholdM,
} from "./centerline-distance-geometry.js";
import {
  COURTYARD_INTERIOR_EDGE_DIST_M,
  MAX_ROAD_VERTEX_TO_CL_DIST_M,
} from "./centerline-distance-config.js";

const COURTYARD_INTERIOR_GRID = 8;
/**
 * セル内部に「CL から 25 m 超かつ RdEdg から 20 m 超」の点があれば true。
 * 道路幅内の点は CL 近傍のため除外される。
 *
 * `edgeIndex` を渡すと縁距離を bbox 剪定する（dense タイルで filter/clip が数百 ms 減る）。
 */
export function hasBlockCourtyardInterior(
  feature: Feature<Polygon>,
  centerlines: LineFeature[],
  edges: LineFeature[],
  clThresholdM: number = MAX_ROAD_VERTEX_TO_CL_DIST_M,
  edgeThresholdM: number = COURTYARD_INTERIOR_EDGE_DIST_M,
  grid: number = COURTYARD_INTERIOR_GRID,
  edgeIndex?: BBoxIndex<LineFeature>
): boolean {
  if (centerlines.length === 0 || edges.length === 0) return false;

  const ring = feature.geometry.coordinates[0] ?? [];
  if (ring.length < 4) return false;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of ring) {
    minX = Math.min(minX, c[0]!);
    maxX = Math.max(maxX, c[0]!);
    minY = Math.min(minY, c[1]!);
    maxY = Math.max(maxY, c[1]!);
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  if (spanX < 1e-12 || spanY < 1e-12) return false;

  // 両辺が 2×縁閾値未満なら、セル内の点が縁から edgeThreshold 超になりにくい
  // （道路回廊はここでスキップされ、街区スケールだけ格子走査する）。
  const lat0 = (minY + maxY) / 2;
  const mLon = metersPerDegLon(lat0);
  const spanXM = spanX * mLon;
  const spanYM = spanY * M_PER_DEG_LAT;
  if (spanXM < 2 * edgeThresholdM && spanYM < 2 * edgeThresholdM) {
    return false;
  }

  const index = edgeIndex ?? BBoxIndex.fromLineFeatures(edges);

  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const coord: Position = [
        minX + ((i + 0.5) / grid) * spanX,
        minY + ((j + 0.5) / grid) * spanY,
      ];
      // Position 直渡しで Feature 割当を避ける
      if (!booleanPointInPolygon(coord, feature)) continue;

      const dCl = minDistToLinesM(coord, centerlines);
      if (dCl <= clThresholdM) continue;

      const dEdge = minDistToLinesWithinThresholdM(
        coord,
        edges,
        edgeThresholdM,
        index
      );
      if (dEdge > edgeThresholdM) return true;
    }
  }
  return false;
}
