import type { GenerationWorkerResponse } from "./generation-messages.js";

export type GenerationWorkerCallbacks = {
  onMessage: (data: GenerationWorkerResponse) => void;
  onFailure: (event: Event) => void;
};

/** Owns Worker creation, event wiring, and teardown for road-surface generation. */
export class GenerationWorkerClient {
  private worker: Worker | null = null;
  private failed = false;
  private readonly createWorker: () => Worker;

  constructor(createWorker: () => Worker) {
    this.createWorker = createWorker;
  }

  ensureWorker(callbacks: GenerationWorkerCallbacks): Worker | null {
    if (this.failed) return null;
    if (this.worker) return this.worker;
    try {
      this.worker = this.createWorker();
      this.worker.onmessage = (event: MessageEvent<GenerationWorkerResponse>) =>
        callbacks.onMessage(event.data);
      this.worker.onerror = callbacks.onFailure;
      this.worker.onmessageerror = callbacks.onFailure;
      return this.worker;
    } catch (error) {
      console.warn("[generation] worker unavailable", error);
      this.failed = true;
      return null;
    }
  }

  hasWorker(): boolean {
    return this.worker !== null;
  }

  terminate(): void {
    if (!this.worker) return;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
    this.worker = null;
  }

  markFailed(): void {
    this.failed = true;
  }

  isFailed(): boolean {
    return this.failed;
  }
}
