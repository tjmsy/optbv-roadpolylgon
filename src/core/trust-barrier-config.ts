import type { LineFeature } from "./types.js";

/** バリア端点のマッチ（同一境界の重複除去）閾値（m） */
export const TRUST_BARRIER_DEDUP_M = 3;
/** safe 端と non-safe 端／線体が「同じ境界」とみなす距離（m） */
export const TRUST_BARRIER_ENDPOINT_MATCH_M = 3;
/** 道路半幅の探索上限（m）。広い幹線でも縁に届かせる */
export const TRUST_BARRIER_MAX_HALF_WIDTH_M = 40;

export interface TrustBarrierDiagnostics {
  candidateBoundaries: number;
  barriersBuilt: number;
  skippedNoTangent: number;
  skippedTooShort: number;
}

export interface TrustBarrierResult {
  barriers: LineFeature[];
  diagnostics: TrustBarrierDiagnostics;
}
