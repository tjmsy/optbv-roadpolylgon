import type { Position } from "geojson";
import {
  analyzeEdgeEndpoints,
  emptyEdgeGapDiagnostics,
} from "./edge-gap-endpoints.js";
import {
  GAP_CONNECTED_EPSILON_M,
  type EdgeGapOptions,
} from "./edge-gap-config.js";
import type { LineFeature } from "./types.js";

export interface DanglingOpeningTip {
  edgeIndex: number;
  end: "a" | "b";
  coord: Position;
  /** 端から縁の内側へ向かう方位（度） */
  inwardBearing: number;
}

/**
 * バッファ後も開口になりうる真のダングリング線端。
 * 他縁端点と共有（橋渡し済み・枝接合含む）や線体 overlap は除外。
 */
export function listDanglingOpeningTips(
  edges: LineFeature[],
  partialOptions?: Partial<Pick<EdgeGapOptions, "connectedEpsilonM">>
): DanglingOpeningTip[] {
  const connectedEpsilonM =
    partialOptions?.connectedEpsilonM ?? GAP_CONNECTED_EPSILON_M;
  const diagnostics = emptyEdgeGapDiagnostics();
  const { freeEndpoints } = analyzeEdgeEndpoints(
    edges,
    connectedEpsilonM,
    diagnostics
  );
  return freeEndpoints.map((endpoint) => ({
    edgeIndex: endpoint.edgeIndex,
    end: endpoint.end,
    coord: endpoint.coord,
    inwardBearing: endpoint.inwardBearing,
  }));
}
