import { GAP_BODY_OVERLAP_EPSILON_M } from "./edge-gap-config.js";
import type { LineFeature } from "./types.js";

/**
 * Pass A（重複断片除去）専用の距離閾値。
 * tip 接合の GAP_CONNECTED_EPSILON_M（0.75 m）とは分ける。
 * 狭い対向縁（〜0.35–0.45 m）を「長い縁に載る断片」と誤認して落とすと、
 * 片側バッファ欠落 → 道路面あふれになる。
 * gap 側の線体 overlap 判定（{@link GAP_BODY_OVERLAP_EPSILON_M}）と同値。
 */
export const OVERLAP_FRAGMENT_EPSILON_M = GAP_BODY_OVERLAP_EPSILON_M;

/**
 * 短い側 / 長い側 がこの比率を超えると断片とみなさない。
 * ほぼ同長の対向縁（例: 22.4 m vs 22.5 m）を落とさないためのガード。
 */
export const OVERLAP_MAX_LENGTH_RATIO = 0.5;

/**
 * degree-2 tip 連結で、両 tip の内向き方位差（0..180）がこれ未満なら結合しない。
 * 対向縁の口（両方とも道路幅方向へ伸びる → 差 ≈0°）を鎖にしない。
 * 折れ曲がり・L 字（差が大きめ）と直線継続（≈180°）は通す。
 * ただし tip がほぼ同一点（≤ COALESCE_EXACT_TIP_M）のときは方位を見ない
 * （U 字コーナー等の意図的接合を壊さない）。
 */
export const COALESCE_MIN_OPPOSITE_BEARING_DEG = 90;

/** これ以下の tip 間距離は「同一接合点」とみなし方位チェックをスキップ */
export const COALESCE_EXACT_TIP_M = 0.05;

export interface CoalesceEdgesDiagnostics {
  inputCount: number;
  outputCount: number;
  overlapFragmentsDropped: number;
  chainsMerged: number;
  edgesAbsorbedInChains: number;
  degree2NodesUsed: number;
  skippedDegreeGe3Nodes: number;
  skippedSameEdgeClusters: number;
  skippedNonContinuation: number;
  attributeConflicts: number;
}

export interface CoalesceEdgesResult {
  edges: LineFeature[];
  diagnostics: CoalesceEdgesDiagnostics;
}

export interface CoalesceEdgesOptions {
  /** tip 接合・次数判定用（既定 GAP_CONNECTED_EPSILON_M） */
  connectedEpsilonM?: number;
  minMeaningfulEdgeM?: number;
  /** Pass A 重複断片除去用（既定 OVERLAP_FRAGMENT_EPSILON_M） */
  overlapEpsilonM?: number;
  /** 短い側/長い側がこれ超なら断片にしない（既定 OVERLAP_MAX_LENGTH_RATIO） */
  overlapMaxLengthRatio?: number;
}

export function emptyCoalesceEdgesDiagnostics(
  inputCount = 0
): CoalesceEdgesDiagnostics {
  return {
    inputCount,
    outputCount: inputCount,
    overlapFragmentsDropped: 0,
    chainsMerged: 0,
    edgesAbsorbedInChains: 0,
    degree2NodesUsed: 0,
    skippedDegreeGe3Nodes: 0,
    skippedSameEdgeClusters: 0,
    skippedNonContinuation: 0,
    attributeConflicts: 0,
  };
}
