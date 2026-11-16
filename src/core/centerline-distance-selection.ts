import type { Feature, Polygon } from "geojson";
import type { LineFeature } from "./types.js";
import { MAX_ROAD_VERTEX_TO_CL_DIST_M } from "./centerline-distance-config.js";
import {
  minDistToLinesM,
  sampleRingVertices,
} from "./centerline-distance-geometry.js";
/**
 * 交わる CL に対し、サンプル点の過半数が thresholdM 以内なら true。
 * 遠い角が少数あってもセル全体を落とさない。
 * 頂点数が多い差分配列は周長に沿った等間隔サンプルで判定する
 * （口元の頂点密集で街区セルを誤採用しない）。
 */
export function majorityVerticesWithinCenterlineDistance(
  feature: Feature<Polygon>,
  centerlines: LineFeature[],
  thresholdM: number = MAX_ROAD_VERTEX_TO_CL_DIST_M
): { ok: boolean; withinCount: number; vertexCount: number; maxDistM: number } {
  const ring = feature.geometry.coordinates[0] ?? [];
  const verts = sampleRingVertices(ring);

  if (verts.length === 0 || centerlines.length === 0) {
    return { ok: false, withinCount: 0, vertexCount: 0, maxDistM: Infinity };
  }

  let withinCount = 0;
  let maxDistM = 0;
  for (const coord of verts) {
    const d = minDistToLinesM(coord, centerlines);
    if (d <= thresholdM) withinCount++;
    if (d > maxDistM) maxDistM = d;
  }

  const ok = withinCount * 2 > verts.length; // strict majority
  return { ok, withinCount, vertexCount: verts.length, maxDistM };
}
