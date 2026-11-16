import type { RoadSurfaceStageMs } from "./types.js";

/** 世代切り替えや AbortSignal による協力的キャンセル */
export class GenerationAbortedError extends Error {
  constructor(message = "Road surface generation aborted") {
    super(message);
    this.name = "GenerationAbortedError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new GenerationAbortedError();
  }
}

export function isGenerationAborted(error: unknown): boolean {
  return (
    error instanceof GenerationAbortedError ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/** 連続 `lap` で段別 ms を積む */
export function createStageClock(): {
  lap: (name: keyof RoadSurfaceStageMs) => void;
  snapshot: () => Partial<RoadSurfaceStageMs>;
} {
  let mark = performance.now();
  const stages: Partial<RoadSurfaceStageMs> = {};
  return {
    lap(name) {
      const now = performance.now();
      stages[name] = Math.round(now - mark);
      mark = now;
    },
    snapshot() {
      return { ...stages };
    },
  };
}
