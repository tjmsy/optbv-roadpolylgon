import { MAX_ROAD_VERTEX_TO_CL_DIST_M } from "./centerline-distance-config.js";

/** 交差点ポケット採用時の頂点〜CL 距離上限（safe 選別と同じ） */
export const MAX_PROVISIONAL_VERTEX_TO_CL_DIST_M = MAX_ROAD_VERTEX_TO_CL_DIST_M;

/** 太い provisional 幹線の半幅探索上限（m）。広い道路の縁側頂点にも対応する。 */
export const PROVISIONAL_ARTERIAL_MAX_HALF_WIDTH_M = 40;

export interface ProvisionalRegionDiagnostics {
  candidateCount: number;
  adoptedCount: number;
  adoptedClosedCount: number;
  adoptedArterialCount: number;
  skippedAlreadySafe: number;
  skippedNoProvisionalIntersect: number;
  /** 交わる provisional がすべて短尺 scrap のみ */
  skippedShortProvisionalOnly: number;
  skippedTouchesBbox: number;
  skippedFarFromBarrier: number;
  skippedFarFromProvisional: number;
  skippedNoDualEdge: number;
  skippedError: number;
}

export function emptyProvisionalRegionDiagnostics(): ProvisionalRegionDiagnostics {
  return {
    candidateCount: 0,
    adoptedCount: 0,
    adoptedClosedCount: 0,
    adoptedArterialCount: 0,
    skippedAlreadySafe: 0,
    skippedNoProvisionalIntersect: 0,
    skippedShortProvisionalOnly: 0,
    skippedTouchesBbox: 0,
    skippedFarFromBarrier: 0,
    skippedFarFromProvisional: 0,
    skippedNoDualEdge: 0,
    skippedError: 0,
  };
}
