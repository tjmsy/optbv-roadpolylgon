export const GENERATION_DEBOUNCE_MS = 300;
/** 自動生成を許可する最小ズーム（それ未満は viewport が広く演算が重い） */
export const GENERATION_MIN_ZOOM = 15;

export function generationZoomSkipMessage(zoomLevel: number): string {
  return `ズーム ${zoomLevel.toFixed(1)} は ${GENERATION_MIN_ZOOM} 未満のため生成しません（表示範囲が広く演算が重いため）。`;
}
