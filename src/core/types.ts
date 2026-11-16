import type { Feature, FeatureCollection, LineString, Polygon } from "geojson";
import type { BufferEdgeDiagnostics } from "./buffer-config.js";
import type { EdgeGapDiagnostics } from "./edge-gap-config.js";
import type { CoalesceEdgesDiagnostics } from "./coalesce-edges.js";
import type { PipelineArtifacts } from "./pipeline-artifacts.js";
import type { CenterlineTrustDiagnostics } from "./centerline-trust-config.js";
import type { TrustBarrierDiagnostics } from "./trust-barriers.js";
import type { ProvisionalRegionDiagnostics } from "./provisional-regions.js";
import type { SpillEdgeSidesDiagnostics } from "./spill-edge-sides.js";

export type Bbox = [west: number, south: number, east: number, north: number];

export type RoadSurfaceFailureCode = "spill-outlier" | "spill-edge-sides";

export interface RoadSurfaceFailure {
  code: RoadSurfaceFailureCode;
  message: string;
  /** @deprecated 旧面積ゲート用。`spill-edge-sides` では未設定 */
  maxRoadAreaM2?: number;
  /** @deprecated 旧面積ゲート用 */
  bboxAreaM2?: number;
  /** @deprecated 旧面積ゲート用 */
  maxRoadShare?: number;
  /** `spill-edge-sides`: ビュー内ダングリング線端数 */
  interiorDanglingTips?: number;
  /** `spill-edge-sides`: 左右とも道路面だった線端数 */
  bothSidesHits?: number;
}

export const GSI_OPTIMAL_BVMAP_PMTILES =
  "https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles";

/** @deprecated Use getDefaultTestArea() from test-areas.ts */
export const POC_BBOX: Bbox = [139.767, 35.681, 139.772, 35.685];

export const DEFAULT_EDGE_LAYER = "RdEdg";
export const DEFAULT_CENTERLINE_LAYER = "RdCL";

/** @deprecated Use DEFAULT_BUFFER_DISTANCE_METERS from buffer-config.ts */
export { DEFAULT_BUFFER_DISTANCE_METERS as DEFAULT_BUFFER_DISTANCE } from "./buffer-config.js";

export const PMTILES_MAX_ZOOM = 16;
export const POC_DISPLAY_ZOOM = 17;

export interface RoadSurfaceOptions {
  bbox: Bbox;
  /** Tile fetch zoom (PMTiles stores up to z16). */
  zoom?: number;
  /** Edge buffer distance in meters (default: DEFAULT_BUFFER_DISTANCE_METERS). */
  bufferDistance?: number;
  edgeLayer?: string;
  centerlineLayer?: string;
  pmtilesUrl?: string;
  /** Enable console diagnostics for buffer drops etc. */
  debug?: boolean;
  /** mid-road 縁ギャップを橋渡ししてからバッファする（default true） */
  closeEdgeGaps?: boolean;
  /**
   * 信頼境バリアを buffer に入れる（default **false**）。
   * 実装は残すが既定オフ。true で A/B・交差点ポケット（provisional-closed）調査用。
   * @see docs/adr/002-centerline-trust-barriers.md
   */
  includeTrustBarriers?: boolean;
  /**
   * 最終道路面をこの bbox にクリップして返す（表示 viewport 用）。
   * 未指定時は作業 bbox のまま。演算は常に `bbox`（余裕込み）で行う。
   */
  clipToBbox?: Bbox;
  /**
   * 調査用中間 artifacts を構築するか（default true）。
   * Realtime UI は false を渡し、road-surface / dangling-tips のみ返す。
   */
  includeArtifacts?: boolean;
  /** Include only the fetched RdEdg input lines in `artifacts['input-rd-edg']`. */
  includeInputEdges?: boolean;
  /**
   * spill-edge-sides 判定と dangling-tips 構築を省略する（default false）。
   * Tile API など品質フラグよりレイテンシ優先の経路向け。`meta.ok` は true 固定。
   */
  skipSpillCheck?: boolean;
  /**
   * true のとき選別を薄くする（default false = 現行フル選別）。
   * safe CL 交差のみ残し、25m majority・courtyard 回収・provisional 採用を省略。
   * ギャップ橋渡し・coalesce・CL trust 分割は維持（道路縁で囲む前提のため）。
   * UI Fast プロファイルが true を渡す。
   */
  simpleSelection?: boolean;
  /** 協力的キャンセル（Worker 経路では terminate を優先） */
  signal?: AbortSignal;
  /**
   * 取得済みの道路縁・中心線を使う。ネットワーク非依存の pipeline test と
   * サーバー側入力再利用用。指定時は PMTiles を取得しない。
   */
  preloadedLayers?: Record<string, LineFeature[]>;
  /** `preloadedLayers` の取得元を示す診断用 tile ID。未指定時は空配列。 */
  preloadedProcessedTiles?: string[];
}

/** パイプライン各段の経過時間（ms）。未到達の段は欠ける。 */
export interface RoadSurfaceStageMs {
  fetch: number;
  coalesce: number;
  gaps: number;
  trust: number;
  barriers: number;
  buffer: number;
  union: number;
  difference: number;
  filter: number;
  provisional: number;
  attributes: number;
  clip: number;
  spill: number;
  artifacts: number;
}

export interface RoadSurfaceMeta {
  processedTiles: string[];
  elapsedMs: number;
  skippedFeatures: number;
  edgeCount: number;
  centerlineCount: number;
  polygonCount: number;
  splitRegionCount: number;
  bufferedEdgeCount: number;
  bufferDistanceMeters: number;
  /** バッファ union に要した時間（ms）。`stageMs.union` と同値 */
  unionMs?: number;
  /** 段別経過時間（ms） */
  stageMs?: Partial<RoadSurfaceStageMs>;
  /** includeArtifacts=false のとき false */
  artifactsIncluded?: boolean;
  buffer: BufferEdgeDiagnostics;
  /** RdEdg 事前結合（overlap 除去・次数2連結） */
  edgeCoalesce?: CoalesceEdgesDiagnostics;
  edgeGaps: EdgeGapDiagnostics;
  /** safe↔provisional/excluded 境の横断バリア */
  trustBarriers?: TrustBarrierDiagnostics;
  /** provisional 閉領域採用（ADR 002 stage 3） */
  provisionalRegions?: ProvisionalRegionDiagnostics;
  /** 結果クリップに使った bbox（指定時） */
  clipToBbox?: Bbox;
  /** @deprecated 面積 suspect レイヤ廃止後は常に 0 */
  suspectRoadCount: number;
  /** @deprecated 面積 suspect レイヤ廃止後は常に 0 */
  suspectAreaThresholdM2: number;
  /** RdCL 信頼区間フィルタの診断 */
  centerlineTrust?: CenterlineTrustDiagnostics;
  /**
   * 生成完了かつあふれ疑いなしなら true。
   * 内陸ダングリング縁端の左右両側が道路面なら false（features は返す）。
   */
  ok: boolean;
  /** `ok=false` 時の自動失敗（現行は `spill-edge-sides`） */
  failure?: RoadSurfaceFailure;
  /** 縁左右サンプルによるあふれチェック診断 */
  spillEdgeSides?: SpillEdgeSidesDiagnostics;
}

export interface RoadSurfaceResult extends FeatureCollection<Polygon> {
  /** 最終道路面（`artifacts['road-surface']` と同一） */
  features: Feature<Polygon>[];
  artifacts: PipelineArtifacts;
  meta: RoadSurfaceMeta;
}

export type LineFeature = Feature<LineString>;
export type LineFeatureCollection = FeatureCollection<LineString>;
export type PolygonFeature = Feature<Polygon>;

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export interface FetchLayerFeaturesOptions {
  bbox: Bbox;
  zoom: number;
  layers: string[];
  pmtilesUrl?: string;
  /** Node scripts: open local PMTiles without fetch/file:// (see scripts/lib/local-pmtiles.ts). */
  pmtilesResolver?: (url: string) => import("pmtiles").PMTiles;
}

export interface FetchLayerFeaturesResult {
  layers: Record<string, LineFeature[]>;
  processedTiles: string[];
}
