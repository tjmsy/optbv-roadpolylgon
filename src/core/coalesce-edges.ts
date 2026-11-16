/**
 * RdEdg 事前正規化: 視覚上1本の縁を幾何的に1本へ寄せる。
 *
 * Pass A — 長い縁の線体に完全に載る短い断片を除去
 * Pass B — 端点次数 2 の tip 接合鎖を 1 本の LineString に連結（T字は残す）
 *
 * @see docs plan: edge coalesce preprocess
 */
import {
  GAP_CONNECTED_EPSILON_M,
  GAP_MIN_MEANINGFUL_EDGE_M,
} from "./edge-gap-config.js";
import type { LineFeature } from "./types.js";
import { dropOverlapFragments } from "./coalesce-overlap.js";
export { dropOverlapFragments } from "./coalesce-overlap.js";
import { mergeDegree2Chains } from "./coalesce-chain-merge.js";
export { mergeDegree2Chains } from "./coalesce-chain-merge.js";
import {
  OVERLAP_FRAGMENT_EPSILON_M,
  OVERLAP_MAX_LENGTH_RATIO,
  emptyCoalesceEdgesDiagnostics,
  type CoalesceEdgesOptions,
  type CoalesceEdgesResult,
} from "./coalesce-edges-config.js";
export * from "./coalesce-edges-config.js";

/**
 * RdEdg をギャップ判定前に正規化する。
 */
export function coalesceRoadEdges(
  edges: LineFeature[],
  partialOptions?: CoalesceEdgesOptions
): CoalesceEdgesResult {
  const epsilonM = partialOptions?.connectedEpsilonM ?? GAP_CONNECTED_EPSILON_M;
  const overlapEpsilonM =
    partialOptions?.overlapEpsilonM ?? OVERLAP_FRAGMENT_EPSILON_M;
  const overlapMaxLengthRatio =
    partialOptions?.overlapMaxLengthRatio ?? OVERLAP_MAX_LENGTH_RATIO;
  const minMeaningfulEdgeM =
    partialOptions?.minMeaningfulEdgeM ?? GAP_MIN_MEANINGFUL_EDGE_M;

  const diagnostics = emptyCoalesceEdgesDiagnostics(edges.length);
  if (edges.length === 0) {
    return { edges: [], diagnostics };
  }

  const afterOverlap = dropOverlapFragments(
    edges,
    overlapEpsilonM,
    overlapMaxLengthRatio
  );
  diagnostics.overlapFragmentsDropped = afterOverlap.dropped;

  const afterChains = mergeDegree2Chains(
    afterOverlap.edges,
    epsilonM,
    minMeaningfulEdgeM,
    diagnostics
  );

  diagnostics.outputCount = afterChains.length;
  return { edges: afterChains, diagnostics };
}
