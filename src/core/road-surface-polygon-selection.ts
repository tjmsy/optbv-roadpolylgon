import type { Feature, Polygon } from "geojson";
import { MAX_ROAD_VERTEX_TO_CL_DIST_M } from "./centerline-distance.js";
import {
  emptyProvisionalRegionDiagnostics,
  selectProvisionalClosedRegions,
  type ProvisionalRegionDiagnostics,
} from "./provisional-regions.js";
import { selectRoadPolygons } from "./road-polygon-selection.js";
import { reselectRoadPolygonsAfterClip } from "./reselect-after-clip.js";
import { attachCenterlineAttributes } from "./road-attributes.js";
import { createStageClock, throwIfAborted } from "./generation-control.js";
import type { Bbox, LineFeature } from "./types.js";

type SelectRoadSurfacePolygonsOptions = {
  splitPolygons: Feature<Polygon>[];
  safeCenterlines: LineFeature[];
  provisionalCenterlines: LineFeature[];
  barriers: LineFeature[];
  edges: LineFeature[];
  bbox: Bbox;
  clipToBbox?: Bbox;
  bufferDistance: number;
  simpleSelection: boolean;
  debug: boolean;
  skipped: { count: number };
  clock: ReturnType<typeof createStageClock>;
  signal?: AbortSignal;
};

export type SelectRoadSurfacePolygonsResult = {
  polygons: Feature<Polygon>[];
  provisionalDiagnostics: ProvisionalRegionDiagnostics;
};

/** Select road regions, apply post-clip filtering, then attach centerline attributes. */
export function selectAndAttributeRoadSurfacePolygons(
  options: SelectRoadSurfacePolygonsOptions
): SelectRoadSurfacePolygonsResult {
  const {
    splitPolygons,
    safeCenterlines,
    provisionalCenterlines,
    barriers,
    edges,
    bbox,
    clipToBbox,
    bufferDistance,
    simpleSelection,
    debug,
    skipped,
    clock,
    signal,
  } = options;

  const selectionResult = selectRoadPolygons(
    splitPolygons,
    safeCenterlines,
    edges,
    bbox,
    simpleSelection,
    skipped
  );
  const { polygons: roadPolygons, safeHitsByPolygon: safeHitsByRoad } =
    selectionResult;
  clock.lap("filter");
  throwIfAborted(signal);
  if (
    debug &&
    (selectionResult.prunedFarFromCenterline > 0 ||
      selectionResult.prunedCourtyardInterior > 0)
  ) {
    console.info("[road-surface] selectionPruned", {
      farFromCenterline: selectionResult.prunedFarFromCenterline,
      courtyardInterior: selectionResult.prunedCourtyardInterior,
      thresholdM: MAX_ROAD_VERTEX_TO_CL_DIST_M,
      simpleSelection,
    });
  }

  const provisionalResult = simpleSelection
    ? {
        adopted: [] as Feature<Polygon>[],
        diagnostics: emptyProvisionalRegionDiagnostics(),
      }
    : selectProvisionalClosedRegions(
        splitPolygons,
        provisionalCenterlines,
        barriers,
        bbox,
        bufferDistance,
        roadPolygons,
        edges
      );
  for (const feature of provisionalResult.adopted) {
    roadPolygons.push(feature);
    safeHitsByRoad.push([]);
  }
  clock.lap("provisional");
  throwIfAborted(signal);
  if (debug) {
    console.info(
      "[road-surface] provisionalRegions",
      provisionalResult.diagnostics,
      {
        simpleSelection,
      }
    );
  }

  /**
   * clipToBbox は work 上でつながったセルを、表示範囲内では道路片と非道路片に
   * 分けうる。選別はクリップ前の親セルに対して行われるため、非道路片が道路面と
   * して残る。クリップ後の各片に同じ safe CL 判定を再適用する。
   */
  let clippedPolygons = roadPolygons;
  let clippedSafeHits = safeHitsByRoad;
  let prunedAfterClip = 0;
  if (clipToBbox) {
    const fromSafePath = safeHitsByRoad.map((hits) => hits.length > 0);
    const reselected = reselectRoadPolygonsAfterClip(
      roadPolygons,
      fromSafePath,
      clipToBbox,
      safeCenterlines,
      simpleSelection ? [] : provisionalCenterlines,
      MAX_ROAD_VERTEX_TO_CL_DIST_M,
      edges,
      { requireVertexNearCenterline: !simpleSelection }
    );
    clippedPolygons = reselected.polygons;
    clippedSafeHits = reselected.safeHits;
    prunedAfterClip = reselected.pruned;
  }
  clock.lap("clip");
  throwIfAborted(signal);
  if (debug && prunedAfterClip > 0) {
    console.info("[road-surface] prunedAfterClip", {
      count: prunedAfterClip,
      thresholdM: MAX_ROAD_VERTEX_TO_CL_DIST_M,
      mode: "reselect-pieces-after-clipToBbox",
      simpleSelection,
    });
  }

  const polygons = attachCenterlineAttributes(
    clippedPolygons,
    [...safeCenterlines, ...provisionalCenterlines],
    {
      knownSafeHits: clippedSafeHits,
      extraCenterlines: provisionalCenterlines,
    }
  );
  clock.lap("attributes");
  throwIfAborted(signal);

  return { polygons, provisionalDiagnostics: provisionalResult.diagnostics };
}
