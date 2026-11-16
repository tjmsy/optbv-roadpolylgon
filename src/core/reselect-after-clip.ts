/**
 * clipToBbox 後の道路片を、safe / provisional CL で再選別する。
 * work 上で道路と非道路がつながった親セルが、クリップで分離したときに
 * 非道路片が道路面として残るのを防ぐ。
 *
 * 中庭判定は親セルの filter 段で実施済み。クリップは部分を切り出すだけなので
 * 「親に無かった中庭」は増えず、ここでの再格子走査は省略する。
 */
import type { Feature, Polygon, Position } from "geojson";
import {
  intersectingCenterlines,
  majorityVerticesWithinCenterlineDistance,
  MAX_ROAD_VERTEX_TO_CL_DIST_M,
} from "./centerline-distance.js";
import { clipPolygonsToBbox } from "./clip-polygons.js";
import { BBoxIndex, polygonFeatureBBox, type BBox4 } from "./spatial-index.js";
import type { Bbox, LineFeature } from "./types.js";

export type ClippedRoadReselectResult = {
  polygons: Feature<Polygon>[];
  safeHits: LineFeature[][];
  pruned: number;
};

const RESELECT_PARENT_KEY = "_reselectParent";

function bboxFullyContainsRing(
  clip: Bbox,
  ring: Position[],
  eps = 1e-12
): boolean {
  const [west, south, east, north] = clip;
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

function bboxesOverlap(a: BBox4, clip: Bbox): boolean {
  return !(
    a[2] < clip[0] ||
    clip[2] < a[0] ||
    a[3] < clip[1] ||
    clip[3] < a[1]
  );
}

export type ReselectAfterClipOptions = {
  /**
   * false のとき safe 片は CL 交差のみ（25m majority 省略）。
   * simpleSelection / Fast 向け。default true。
   */
  requireVertexNearCenterline?: boolean;
};

/**
 * @param roadPolygons クリップ前の採用セル
 * @param fromSafePath 同じ長さ。true = safe CL 選別由来、false = provisional 由来
 */
export function reselectRoadPolygonsAfterClip(
  roadPolygons: Feature<Polygon>[],
  fromSafePath: boolean[],
  clipToBbox: Bbox,
  safeCenterlines: LineFeature[],
  provisionalCenterlines: LineFeature[],
  thresholdM: number = MAX_ROAD_VERTEX_TO_CL_DIST_M,
  _edges: LineFeature[] = [],
  options?: ReselectAfterClipOptions
): ClippedRoadReselectResult {
  const requireVertexNear = options?.requireVertexNearCenterline ?? true;
  const safeIndex = BBoxIndex.fromLineFeatures(safeCenterlines);
  const provisionalIndex = BBoxIndex.fromLineFeatures(provisionalCenterlines);
  const polygons: Feature<Polygon>[] = [];
  const safeHits: LineFeature[][] = [];
  let pruned = 0;

  const toClip: Feature<Polygon>[] = [];
  const piecesByParent = new Map<number, Feature<Polygon>[]>();

  for (let i = 0; i < roadPolygons.length; i++) {
    const parent = roadPolygons[i]!;
    const ring = parent.geometry.coordinates[0] ?? [];
    const parentBox = polygonFeatureBBox(parent);
    if (!bboxesOverlap(parentBox, clipToBbox)) {
      piecesByParent.set(i, []);
      continue;
    }
    if (bboxFullyContainsRing(clipToBbox, ring)) {
      piecesByParent.set(i, [parent]);
      continue;
    }
    toClip.push({
      type: "Feature",
      properties: { ...(parent.properties ?? {}), [RESELECT_PARENT_KEY]: i },
      geometry: parent.geometry,
    });
  }

  if (toClip.length > 0) {
    for (const piece of clipPolygonsToBbox(toClip, clipToBbox)) {
      const parentIdx = Number(piece.properties?.[RESELECT_PARENT_KEY]);
      if (!Number.isFinite(parentIdx)) continue;
      const list = piecesByParent.get(parentIdx) ?? [];
      const props = { ...(piece.properties ?? {}) };
      delete props[RESELECT_PARENT_KEY];
      list.push({
        ...piece,
        properties: props,
      });
      piecesByParent.set(parentIdx, list);
    }
  }

  for (let i = 0; i < roadPolygons.length; i++) {
    const fromSafe = fromSafePath[i] ?? true;
    const pieces = piecesByParent.get(i) ?? [];
    for (const piece of pieces) {
      if (fromSafe) {
        const hitting = intersectingCenterlines(piece, safeIndex);
        if (hitting.length === 0) {
          pruned++;
          continue;
        }
        if (requireVertexNear) {
          const distCheck = majorityVerticesWithinCenterlineDistance(
            piece,
            hitting,
            thresholdM
          );
          if (!distCheck.ok) {
            pruned++;
            continue;
          }
        }
        polygons.push(piece);
        safeHits.push(hitting);
      } else {
        const provHits = intersectingCenterlines(piece, provisionalIndex);
        if (provHits.length === 0) {
          pruned++;
          continue;
        }
        polygons.push(piece);
        safeHits.push([]);
      }
    }
  }

  return { polygons, safeHits, pruned };
}
