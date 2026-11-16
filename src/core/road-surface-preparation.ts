import { droppedBufferCount } from "./buffer-config.js";
import { bufferEdgeFeatures } from "./buffer-edges.js";
import { closeEdgeGaps } from "./edge-gaps.js";
import { coalesceRoadEdges } from "./coalesce-edges.js";
import { splitCenterlinesForRoadSelection } from "./centerline-trust.js";
import { buildTrustBarriers } from "./trust-barriers.js";
import { unionAllPolygonsDetailed } from "./union-polygons.js";
import { createStageClock, throwIfAborted } from "./generation-control.js";
import type { Bbox, LineFeature } from "./types.js";

type PrepareRoadSurfaceGeometryOptions = {
  edges: LineFeature[];
  centerlines: LineFeature[];
  bbox: Bbox;
  bufferDistance: number;
  closeGaps: boolean;
  includeTrustBarriers: boolean;
  debug: boolean;
  skipped: { count: number };
  clock: ReturnType<typeof createStageClock>;
  signal?: AbortSignal;
};

/** Run edge and centerline preparation through buffered-edge union. */
export function prepareRoadSurfaceGeometry(
  options: PrepareRoadSurfaceGeometryOptions
) {
  const {
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
  } = options;

  const coalesceResult = coalesceRoadEdges(edges);
  const coalescedEdges = coalesceResult.edges;
  clock.lap("coalesce");
  throwIfAborted(signal);
  if (debug) {
    console.info("[road-surface] edgeCoalesce", coalesceResult.diagnostics);
  }

  const gapResult = closeEdgeGaps(coalescedEdges, centerlines, {
    bridgeMidRoad: closeGaps,
    workBbox: bbox,
  });
  clock.lap("gaps");
  throwIfAborted(signal);
  if (debug) {
    console.info("[road-surface] edgeGaps", gapResult.diagnostics);
  }

  const clTrust = splitCenterlinesForRoadSelection(
    centerlines,
    coalescedEdges,
    gapResult.gapFeatures
  );
  const centerlinesForSelection = clTrust.safe;
  clock.lap("trust");
  throwIfAborted(signal);

  const barrierResult = includeTrustBarriers
    ? buildTrustBarriers(
        clTrust.safe,
        clTrust.provisional,
        clTrust.excluded,
        coalescedEdges
      )
    : {
        barriers: [] as LineFeature[],
        diagnostics: {
          candidateBoundaries: 0,
          barriersBuilt: 0,
          skippedNoTangent: 0,
          skippedTooShort: 0,
        },
      };
  const edgesForBuffer: LineFeature[] = [
    ...gapResult.edges,
    ...barrierResult.barriers,
  ];
  clock.lap("barriers");
  throwIfAborted(signal);
  if (debug) {
    console.info("[road-surface] centerlineTrust", clTrust.diagnostics);
    console.info("[road-surface] trustBarriers", barrierResult.diagnostics, {
      includeTrustBarriers,
    });
  }

  const { polygons: bufferedEdges, diagnostics: bufferDiag } =
    bufferEdgeFeatures(edgesForBuffer, {
      distanceMeters: bufferDistance,
      debug,
    });
  skipped.count += droppedBufferCount(bufferDiag);
  clock.lap("buffer");
  throwIfAborted(signal);

  const unionResult = unionAllPolygonsDetailed(bufferedEdges, skipped);
  const mergedBuffer = unionResult.feature;
  clock.lap("union");
  throwIfAborted(signal);
  const stageMsSoFar = clock.snapshot();
  const unionMs = stageMsSoFar.union ?? 0;
  if (debug) {
    console.info("[road-surface] union", {
      strategy: unionResult.strategy,
      inputCount: bufferedEdges.length,
      unionMs,
      usedConcat: unionResult.usedConcat,
      pcRecoveries: unionResult.pcRecoveries,
      concatParts: unionResult.concatParts,
    });
  }

  return {
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
  };
}
