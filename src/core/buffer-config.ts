import type { Feature, LineString } from "geojson";

/**
 * z16 MVT の概算格子間隔（地球円周 / 2^16 / 4096 ≈ 0.15 m）。
 * これより細いバッファは量子化ノイズに埋もれやすい。
 */
export const MVT_Z16_RESOLUTION_METERS = 0.15;

/**
 * 道路縁バッファ距離のデフォルト（メートル）。
 * MVT z16 解像度（≈0.15 m）以上。0.15 m ぴったりは量子化と同程度で厳しいため、
 * レビュー 002 の推奨下限付近 **0.2 m**（旧デフォルト 0.5 m は高ズームで目立ちやすかった）。
 * QGIS 記事の 0.01 m には特別な意味はなく、分割用ギャップとしてソース解像度以上であればよい。
 */
export const DEFAULT_BUFFER_DISTANCE_METERS = 0.2;

export type LineFeature = Feature<LineString>;

export interface BufferEdgeDiagnostics {
  /** buffer() が undefined（NaN 等）を返した件数 */
  undefinedResult: number;
  /** MultiPolygon を flatten して採用した件数（元フィーチャ単位） */
  multipolygonExpanded: number;
  /** try/catch で例外になった件数 */
  exception: number;
  /** Polygon/MultiPolygon 以外で破棄した件数 */
  unsupportedGeometry: number;
  /** 最終的に採用した Polygon 数 */
  acceptedPolygons: number;
  /** 入力 LineString 数 */
  inputCount: number;
}

export interface BufferEdgesOptions {
  distanceMeters: number;
  /** true のときコンソールへ診断ログ */
  debug?: boolean;
  log?: (message: string, detail?: unknown) => void;
}

export function emptyBufferDiagnostics(inputCount = 0): BufferEdgeDiagnostics {
  return {
    undefinedResult: 0,
    multipolygonExpanded: 0,
    exception: 0,
    unsupportedGeometry: 0,
    acceptedPolygons: 0,
    inputCount,
  };
}

export function droppedBufferCount(d: BufferEdgeDiagnostics): number {
  return d.undefinedResult + d.exception + d.unsupportedGeometry;
}
