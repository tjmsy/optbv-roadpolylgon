import type { Feature, LineString } from "geojson";

/** 縁線体からこの距離以内をコリドー内とみなす（m） */
export const CL_CORRIDOR_MAX_DIST_M = 10;
/** 安全区間として採用する最小長（m） */
export const CL_SAFE_MIN_LENGTH_M = 2;

/**
 * RdCL のトンネル地物種別コード。
 * 27xx の末尾 04 は道路中心線 / ２条 / 徒歩道 / 石段のトンネルを表す。
 */
export const RDCL_TUNNEL_VT_CODES = new Set([2704, 2714, 2724, 2734]);
/** 27xx の末尾 21–24 は徒歩道の通常部・雪覆い・橋・トンネル。 */
export const RDCL_FOOTPATH_VT_CODES = new Set([2721, 2722, 2723, 2724]);

export interface CenterlineTrustDiagnostics {
  inputLineCount: number;
  safeSegmentCount: number;
  provisionalSegmentCount: number;
  excludedSegmentCount: number;
  /** 未橋渡し gap 接触で両側支持不足などにより excluded になった数 */
  corridorExcludedSegments: number;
  /** コリドー外として provisional になった数 */
  corridorProvisionalSegments: number;
  deadEndOutsideSegments: number;
  deadEndAmbiguousSegments: number;
  shortExcludedSegments: number;
  tunnelExcludedSegments: number;
  footpathExcludedSegments: number;
  edgeCrossingCuts: number;
  gapCrossingCuts: number;
}

export interface CenterlineTrustResult {
  safe: Feature<LineString>[];
  provisional: Feature<LineString>[];
  excluded: Feature<LineString>[];
  diagnostics: CenterlineTrustDiagnostics;
}

export type ClTrustKind = "safe" | "provisional" | "excluded";

export type ClTrustReason =
  | "dual-edge-support"
  | "corridor-uncertain"
  | "insufficient-edge-support"
  | "dead-end-outside"
  | "dead-end-ambiguous"
  | "segment-too-short"
  | "tunnel-vt-code"
  | "footpath-vt-code";
