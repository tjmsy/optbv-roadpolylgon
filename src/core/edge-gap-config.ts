import type { Feature, LineString } from "geojson";

type EdgeGapBbox = [west: number, south: number, east: number, north: number];
type EdgeGapLineFeature = Feature<LineString>;

/** これ以下は既に接続とみなす（m） */
export const GAP_CONNECTED_EPSILON_M = 0.75;
/** 端点が他縁線体上にあるとみなす距離（m）。tip 接合閾値より狭い。 */
export const GAP_BODY_OVERLAP_EPSILON_M = 0.25;
/** 通常の自動接続上限（m）。 */
export const GAP_MAX_BRIDGE_M = 15;
/** 中心線と並行する mid-road ギャップの接続上限（m）。 */
export const GAP_MAX_BRIDGE_MID_ROAD_M = 30;
/** トポロジ判定で無視する微短線分の最小長さ（m）。 */
export const GAP_MIN_MEANINGFUL_EDGE_M = 0.5;
/** 短い端点を複数の本線に接続するハブとして扱う閾値（m）。 */
export const GAP_STUB_HUB_MAX_M = 2;
/** @deprecated 接合端は長さに依らず候補外。互換のため維持。 */
export const GAP_JOIN_SPUR_MAX_M = 8;
/** 中心線と並行とみなす最大角（0=並行, 90=垂直） */
export const GAP_PARALLEL_MAX_DEG = 45;
/** @deprecated 接合端は候補外にしたため未使用。 */
export const GAP_JOINED_PAIR_CONTINUATION_MAX_DEG = 25;
/** self-close とみなす最小の路長/弦長比。 */
export const GAP_SELF_CLOSE_MIN_PATH_RATIO = 1.5;
/** 行き止まり（横断閉じ）とみなす最小角 */
export const GAP_PERPENDICULAR_MIN_DEG = 55;
/** 中心線が十分近いとみなす距離（m）。 */
export const GAP_CL_NEAR_M = 15;
/** 中心線方位の参考に使う最大距離（m）。 */
export const GAP_CL_HINT_M = 40;
/** 中心線端点付近とみなす距離（m）。 */
export const GAP_CL_ENDPOINT_NEAR_M = 8;
/** work bbox 辺上とみなす距離（m）。 */
export const GAP_WORK_BOUNDARY_EPSILON_M = 0.25;

export type EdgeGapKind =
  "mid-road" | "dead-end" | "ambiguous" | "self-close" | "overlap" | "topology";

export interface EdgeGapOptions {
  connectedEpsilonM: number;
  maxBridgeM: number;
  maxBridgeMidRoadM: number;
  parallelMaxDeg: number;
  perpendicularMinDeg: number;
  clNearM: number;
  clHintM: number;
  clEndpointNearM: number;
  bridgeMidRoad: boolean;
  workBbox?: EdgeGapBbox;
  workBoundaryEpsilonM?: number;
}

export interface EdgeGapDiagnostics {
  danglingEndpoints: number;
  candidatePairs: number;
  midRoad: number;
  deadEnd: number;
  ambiguous: number;
  selfClose: number;
  overlap: number;
  topology: number;
  closedRingsSkipped: number;
  bridged: number;
  skippedEndpointReuse: number;
  skippedWorkBoundary: number;
}

export interface CloseEdgeGapsResult {
  edges: EdgeGapLineFeature[];
  gapFeatures: Feature<LineString>[];
  diagnostics: EdgeGapDiagnostics;
}

export const DEFAULT_EDGE_GAP_OPTIONS: EdgeGapOptions = {
  connectedEpsilonM: GAP_CONNECTED_EPSILON_M,
  maxBridgeM: GAP_MAX_BRIDGE_M,
  maxBridgeMidRoadM: GAP_MAX_BRIDGE_MID_ROAD_M,
  parallelMaxDeg: GAP_PARALLEL_MAX_DEG,
  perpendicularMinDeg: GAP_PERPENDICULAR_MIN_DEG,
  clNearM: GAP_CL_NEAR_M,
  clHintM: GAP_CL_HINT_M,
  clEndpointNearM: GAP_CL_ENDPOINT_NEAR_M,
  bridgeMidRoad: true,
};
