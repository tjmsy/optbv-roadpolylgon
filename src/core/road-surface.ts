import flatten from "@turf/flatten";
import { featureCollection, polygon } from "@turf/helpers";
import type { Feature, Polygon } from "geojson";
import {
  tagArtifactFeatures,
  toFeatureCollection,
} from "./artifact-helpers.js";
import { bboxToPolygonRing } from "./bbox.js";
import {
  DEFAULT_BUFFER_DISTANCE_METERS,
  emptyBufferDiagnostics,
} from "./buffer-config.js";
import { emptyEdgeGapDiagnostics } from "./edge-gaps.js";
import { listDanglingOpeningTips } from "./edge-gap-dangling.js";
import type { EdgeGapDiagnostics } from "./edge-gap-config.js";
import { emptyCoalesceEdgesDiagnostics } from "./coalesce-edges.js";
import type { CoalesceEdgesDiagnostics } from "./coalesce-edges.js";
import {
  emptyPipelineArtifacts,
  type PipelineArtifacts,
} from "./pipeline-artifacts.js";
import {
  DEFAULT_CENTERLINE_LAYER,
  DEFAULT_EDGE_LAYER,
  PMTILES_MAX_ZOOM,
  type RoadSurfaceOptions,
  type RoadSurfaceResult,
  type RoadSurfaceStageMs,
} from "./types.js";
import {
  buildDanglingTipFeatures,
  evaluateSpillByEdgeSides,
  skippedSpillEdgeSidesResult,
} from "./spill-edge-sides.js";
import { fetchLayerFeatures } from "./tile-fetch.js";
import { differenceRoadSurfaceWorkArea } from "./road-surface-difference.js";
import { selectAndAttributeRoadSurfacePolygons } from "./road-surface-polygon-selection.js";
import { prepareRoadSurfaceGeometry } from "./road-surface-preparation.js";
import { createStageClock, throwIfAborted } from "./generation-control.js";
import {
  buildFinalRoadSurfaceArtifacts,
  buildInvestigationArtifacts,
} from "./road-surface-artifacts.js";

function buildEmptyResult(
  processedTiles: string[],
  started: number,
  skipped: number,
  edges: number,
  centerlines: number,
  bufferDistanceMeters: number,
  edgeGaps: EdgeGapDiagnostics = emptyEdgeGapDiagnostics(),
  edgeCoalesce: CoalesceEdgesDiagnostics = emptyCoalesceEdgesDiagnostics(),
  stageMs?: Partial<RoadSurfaceStageMs>,
  artifactsIncluded = true
): RoadSurfaceResult {
  return {
    type: "FeatureCollection",
    features: [],
    artifacts: emptyPipelineArtifacts(),
    meta: {
      processedTiles,
      elapsedMs: performance.now() - started,
      skippedFeatures: skipped,
      edgeCount: edges,
      centerlineCount: centerlines,
      polygonCount: 0,
      splitRegionCount: 0,
      bufferedEdgeCount: 0,
      bufferDistanceMeters,
      ...(stageMs ? { stageMs, unionMs: stageMs.union } : {}),
      artifactsIncluded,
      buffer: emptyBufferDiagnostics(edges),
      edgeCoalesce,
      edgeGaps,
      suspectRoadCount: 0,
      suspectAreaThresholdM2: 0,
      ok: true,
    },
  };
}

/**
 * QGIS ワークフロー相当の道路面生成。
 * 入力・演算・出力はすべて WGS84。バッファ距離は Turf の meters（局所投影）を使用。
 * バッファ前に縁端点ギャップを橋渡しする。
 */
export async function generateRoadSurface(
  options: RoadSurfaceOptions
): Promise<RoadSurfaceResult> {
  const started = performance.now();
  const skipped = { count: 0 };
  const clock = createStageClock();

  const {
    bbox,
    zoom = PMTILES_MAX_ZOOM,
    bufferDistance = DEFAULT_BUFFER_DISTANCE_METERS,
    edgeLayer = DEFAULT_EDGE_LAYER,
    centerlineLayer = DEFAULT_CENTERLINE_LAYER,
    pmtilesUrl,
    debug = false,
    closeEdgeGaps: closeGaps = true,
    includeTrustBarriers = false,
    clipToBbox,
    includeArtifacts = true,
    includeInputEdges = false,
    skipSpillCheck = false,
    simpleSelection = false,
    signal,
  } = options;

  throwIfAborted(signal);

  const fetched = options.preloadedLayers
    ? {
        layers: options.preloadedLayers,
        processedTiles: options.preloadedProcessedTiles ?? [],
      }
    : await fetchLayerFeatures({
        bbox,
        zoom,
        layers: [edgeLayer, centerlineLayer],
        pmtilesUrl,
      });
  const { layers, processedTiles } = fetched;
  clock.lap("fetch");
  throwIfAborted(signal);

  const edges = layers[edgeLayer] ?? [];
  const centerlines = layers[centerlineLayer] ?? [];

  const bboxPoly = polygon([bboxToPolygonRing(bbox)]);

  const {
    coalesceResult,
    coalescedEdges,
    gapResult,
    clTrust,
    centerlinesForSelection,
    barrierResult,
    bufferedEdges,
    bufferDiag,
    unionResult,
    mergedBuffer,
    unionMs,
  } = prepareRoadSurfaceGeometry({
    edges,
    centerlines,
    bbox,
    bufferDistance,
    closeGaps,
    includeTrustBarriers,
    debug,
    skipped,
    clock,
    signal,
  });

  const investigationArtifacts = () => ({
    ...buildInvestigationArtifacts({
      includeArtifacts,
      edges,
      centerlines,
      bbox,
      clipToBbox,
      zoom,
      coalescedEdges,
      gapFeatures: gapResult.gapFeatures,
      barriers: barrierResult.barriers,
      bufferedEdges,
      mergedBuffer,
      safeCenterlines: clTrust.safe,
      provisionalCenterlines: clTrust.provisional,
      excludedCenterlines: clTrust.excluded,
    }),
    ...(includeInputEdges
      ? { "input-rd-edg": toFeatureCollection(edges) }
      : {}),
  });

  const withBaseMeta = (result: RoadSurfaceResult): RoadSurfaceResult => {
    result.meta.edgeCoalesce = coalesceResult.diagnostics;
    result.meta.edgeGaps = gapResult.diagnostics;
    result.meta.trustBarriers = barrierResult.diagnostics;
    result.meta.centerlineTrust = clTrust.diagnostics;
    result.meta.artifactsIncluded = includeArtifacts;
    result.meta.stageMs = clock.snapshot();
    result.meta.unionMs = result.meta.stageMs.union ?? unionMs;
    result.meta.elapsedMs = performance.now() - started;
    return result;
  };

  const buildEmptyOutcome = (): RoadSurfaceResult => {
    clock.lap("artifacts");
    const result = withBaseMeta(
      buildEmptyResult(
        processedTiles,
        started,
        skipped.count,
        edges.length,
        centerlines.length,
        bufferDistance,
        gapResult.diagnostics,
        coalesceResult.diagnostics,
        clock.snapshot(),
        includeArtifacts
      )
    );
    result.artifacts = {
      ...emptyPipelineArtifacts(),
      ...investigationArtifacts(),
      "dangling-tips": toFeatureCollection(
        tagArtifactFeatures(
          buildDanglingTipFeatures(gapResult.edges, clipToBbox ?? bbox),
          "dangling-tips",
          6
        )
      ),
    };
    result.meta.bufferedEdgeCount = bufferedEdges.length;
    result.meta.buffer = bufferDiag;
    return result;
  };

  if (!mergedBuffer) {
    return buildEmptyOutcome();
  }

  const diffResult = differenceRoadSurfaceWorkArea(
    bboxPoly,
    mergedBuffer,
    bufferedEdges,
    unionResult.usedConcat
  );
  const splitRegion = diffResult.feature;
  if (!splitRegion && diffResult.strategy !== "polygon-clipping") {
    skipped.count++;
  }
  if (debug) {
    console.info("[road-surface] difference", {
      strategy: diffResult.strategy,
      ok: Boolean(splitRegion),
    });
  }
  clock.lap("difference");
  throwIfAborted(signal);

  if (!splitRegion) {
    return buildEmptyOutcome();
  }

  const flattened = flatten(featureCollection([splitRegion]));
  const splitPolygons = flattened.features.filter(
    (f): f is Feature<Polygon> => f.geometry.type === "Polygon"
  );

  const { polygons: outputPolygons, provisionalDiagnostics } =
    selectAndAttributeRoadSurfacePolygons({
      splitPolygons,
      safeCenterlines: centerlinesForSelection,
      provisionalCenterlines: clTrust.provisional,
      barriers: barrierResult.barriers,
      edges,
      bbox,
      clipToBbox,
      bufferDistance,
      simpleSelection,
      debug,
      skipped,
      clock,
      signal,
    });
  const qualityBbox = clipToBbox ?? bbox;

  const danglingTips = skipSpillCheck
    ? []
    : listDanglingOpeningTips(gapResult.edges);
  const spillCheck = skipSpillCheck
    ? skippedSpillEdgeSidesResult()
    : evaluateSpillByEdgeSides(gapResult.edges, outputPolygons, qualityBbox, {
        danglingTips,
      });
  clock.lap("spill");
  throwIfAborted(signal);
  if (debug) {
    console.info(
      "[road-surface] spillEdgeSides",
      spillCheck.diagnostics,
      spillCheck.hits
    );
  }

  const finalArtifacts = buildFinalRoadSurfaceArtifacts({
    includeArtifacts,
    skipSpillCheck,
    gapEdges: gapResult.edges,
    qualityBbox,
    spillHits: spillCheck.hits,
    danglingTips,
    outputPolygons,
    splitPolygons,
  });
  const artifacts: PipelineArtifacts = {
    ...finalArtifacts.artifacts,
    ...investigationArtifacts(),
  };
  clock.lap("artifacts");

  const usableFeatures = finalArtifacts.features;
  const stageMs = clock.snapshot();

  if (debug) {
    console.info("[road-surface] stageMs", stageMs);
  }

  return {
    type: "FeatureCollection",
    features: usableFeatures,
    artifacts,
    meta: {
      processedTiles,
      elapsedMs: performance.now() - started,
      skippedFeatures: skipped.count,
      edgeCount: edges.length,
      centerlineCount: centerlines.length,
      polygonCount: usableFeatures.length,
      splitRegionCount: splitPolygons.length,
      bufferedEdgeCount: bufferedEdges.length,
      bufferDistanceMeters: bufferDistance,
      unionMs: stageMs.union,
      stageMs,
      artifactsIncluded: includeArtifacts,
      buffer: bufferDiag,
      edgeCoalesce: coalesceResult.diagnostics,
      edgeGaps: gapResult.diagnostics,
      trustBarriers: barrierResult.diagnostics,
      provisionalRegions: provisionalDiagnostics,
      ...(clipToBbox ? { clipToBbox } : {}),
      suspectRoadCount: 0,
      suspectAreaThresholdM2: 0,
      centerlineTrust: clTrust.diagnostics,
      spillEdgeSides: spillCheck.diagnostics,
      ok: spillCheck.ok,
      ...(spillCheck.failure ? { failure: spillCheck.failure } : {}),
    },
  };
}
