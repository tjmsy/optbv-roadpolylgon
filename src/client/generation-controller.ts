import { generateRoadSurface as defaultGenerateRoadSurface } from "../core/road-surface.js";
import { isGenerationAborted } from "../core/generation-control.js";
import type { RoadSurfaceOptions, RoadSurfaceResult } from "../core/types.js";
import type {
  GenerationRequest,
  GenerationWorkerResponse,
} from "./generation-messages.js";
import { GenerationWorkerClient } from "./generation-worker-client.js";
import {
  GENERATION_DEBOUNCE_MS,
  GENERATION_MIN_ZOOM,
  generationZoomSkipMessage,
} from "./generation-config.js";
export {
  GENERATION_DEBOUNCE_MS,
  GENERATION_MIN_ZOOM,
} from "./generation-config.js";

export type GenerationHandlers = {
  onStarted?: (info: { id: number; bboxLabel: string }) => void;
  onSuccess?: (info: { id: number; result: RoadSurfaceResult }) => void;
  onError?: (info: { id: number; message: string }) => void;
  onSkipped?: (reason: string) => void;
};

export type GenerationControllerDeps = {
  createWorker?: () => Worker;
  generateRoadSurface?: (
    options: RoadSurfaceOptions
  ) => Promise<RoadSurfaceResult>;
};

type ActiveRequest = {
  id: number;
  mainOptions: RoadSurfaceOptions;
  fallbackStarted: boolean;
};

/**
 * 道路面生成のデバウンス・世代管理・Worker 呼び出し。
 * 新しい生成が始まると飛行中 Worker を terminate し、メインスレッド経路は AbortSignal で中断する。
 * Worker runtime error 時は同一世代をメインスレッドで一度だけ再実行する。
 */
export class RoadSurfaceGenerationController {
  private readonly workerClient: GenerationWorkerClient;
  private workerBusy = false;
  /** Worker に送った最新要求 id。意図的 abort 時は先に null にする。 */
  private workerRequestId: number | null = null;
  private nextId = 0;
  private activeId: number | null = null;
  private activeRequest: ActiveRequest | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private handlers: GenerationHandlers = {};
  private readonly generateRoadSurface: (
    options: RoadSurfaceOptions
  ) => Promise<RoadSurfaceResult>;

  constructor(deps: GenerationControllerDeps = {}) {
    const createWorker =
      deps.createWorker ??
      (() =>
        new Worker(new URL("./road-surface.worker.ts", import.meta.url), {
          type: "module",
        }));
    this.workerClient = new GenerationWorkerClient(createWorker);
    this.generateRoadSurface =
      deps.generateRoadSurface ?? defaultGenerateRoadSurface;
  }

  setHandlers(handlers: GenerationHandlers): void {
    this.handlers = handlers;
  }

  private ensureWorker(): Worker | null {
    return this.workerClient.ensureWorker({
      onMessage: (data) => this.handleWorkerMessage(data),
      onFailure: (event) => this.handleWorkerFailure(event),
    });
  }

  /** 飛行中の Worker を破棄して次の生成に備える（意図的停止のため workerFailed は立てない） */
  private abortWorkerInFlight(): void {
    if (!this.workerBusy && !this.workerClient.hasWorker()) return;
    this.workerRequestId = null;
    this.workerClient.terminate();
    this.workerBusy = false;
  }

  private clearActiveRequestIf(id: number): void {
    if (this.activeRequest?.id === id) {
      this.activeRequest = null;
    }
  }

  private handleWorkerFailure(event: Event): void {
    const failedId = this.workerRequestId;
    console.warn("[generation] worker error; retrying on main thread", event);
    this.workerClient.markFailed();
    this.workerBusy = false;
    this.workerRequestId = null;
    this.workerClient.terminate();

    const request = this.activeRequest;
    if (
      failedId == null ||
      !request ||
      request.id !== failedId ||
      request.id !== this.activeId ||
      request.fallbackStarted
    ) {
      return;
    }
    request.fallbackStarted = true;
    console.warn(`[generation] worker-fallback id=${request.id}`);
    void this.runOnMainThread(request.id, request.mainOptions);
  }

  private handleWorkerMessage(data: GenerationWorkerResponse): void {
    if (!data) return;
    if (data.id === this.activeId) {
      this.workerBusy = false;
      this.workerRequestId = null;
    }
    if (data.id !== this.activeId) return;
    const request = this.activeRequest;
    if (request?.id === data.id && request.fallbackStarted) return;

    if (data.type === "result") {
      this.clearActiveRequestIf(data.id);
      this.handlers.onSuccess?.({ id: data.id, result: data.result });
      return;
    }
    if (data.type === "error") {
      this.clearActiveRequestIf(data.id);
      this.handlers.onError?.({ id: data.id, message: data.message });
    }
  }

  private async runOnMainThread(
    id: number,
    options: RoadSurfaceOptions
  ): Promise<void> {
    try {
      const result = await this.generateRoadSurface(options);
      if (this.activeId !== id) return;
      this.clearActiveRequestIf(id);
      this.handlers.onSuccess?.({ id, result });
    } catch (error) {
      if (this.activeId !== id) return;
      if (isGenerationAborted(error)) return;
      this.clearActiveRequestIf(id);
      this.handlers.onError?.({
        id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 進行中のデバウンスを取り消す（結果待ちは世代で無視） */
  cancelScheduled(): void {
    if (this.debounceTimer != null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** 結果を無視し、飛行中の生成も止める */
  invalidateInFlight(): void {
    this.activeId = null;
    this.activeRequest = null;
    this.cancelScheduled();
    this.abortController?.abort();
    this.abortController = null;
    this.abortWorkerInFlight();
  }

  /**
   * debounce 後に生成。zoom が低い場合はスキップ。
   */
  schedule(
    options: RoadSurfaceOptions & { zoomLevel?: number },
    debounceMs = GENERATION_DEBOUNCE_MS
  ): void {
    this.cancelScheduled();
    const zoomLevel = options.zoomLevel;
    if (zoomLevel != null && zoomLevel < GENERATION_MIN_ZOOM) {
      this.handlers.onSkipped?.(generationZoomSkipMessage(zoomLevel));
      return;
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.run(options);
    }, debounceMs);
  }

  /** 即時生成（ボタン用） */
  async runNow(
    options: RoadSurfaceOptions & { zoomLevel?: number }
  ): Promise<void> {
    this.cancelScheduled();
    const zoomLevel = options.zoomLevel;
    if (zoomLevel != null && zoomLevel < GENERATION_MIN_ZOOM) {
      this.handlers.onSkipped?.(generationZoomSkipMessage(zoomLevel));
      return;
    }
    await this.run(options);
  }

  private async run(options: RoadSurfaceOptions): Promise<void> {
    const id = ++this.nextId;
    this.activeId = id;
    const bboxLabel = options.bbox.map((v) => v.toFixed(5)).join(", ");
    this.handlers.onStarted?.({ id, bboxLabel });

    // 前世代を止める（Worker は terminate、メインは AbortSignal）
    this.abortController?.abort();
    this.abortWorkerInFlight();
    this.abortController = new AbortController();
    const { signal: _ignored, ...workerOptions } = options;
    const mainOptions: RoadSurfaceOptions = {
      ...options,
      signal: this.abortController.signal,
    };
    this.activeRequest = { id, mainOptions, fallbackStarted: false };

    const worker = this.ensureWorker();
    if (worker) {
      this.workerBusy = true;
      this.workerRequestId = id;
      const message: GenerationRequest = {
        type: "generate",
        id,
        options: workerOptions,
      };
      try {
        worker.postMessage(message);
      } catch (error) {
        console.warn("[generation] worker postMessage failed", error);
        this.handleWorkerFailure(new Event("error"));
      }
      return;
    }

    await this.runOnMainThread(id, mainOptions);
  }

  dispose(): void {
    this.invalidateInFlight();
    this.workerClient.terminate();
  }

  /** テスト用: Worker 利用が無効化されたか */
  isWorkerFailed(): boolean {
    return this.workerClient.isFailed();
  }
}
