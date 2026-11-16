import { generateRoadSurface } from "../core/road-surface.js";
import type {
  GenerationRequest,
  GenerationWorkerResponse,
} from "./generation-messages.js";

self.onmessage = (event: MessageEvent<GenerationRequest>) => {
  const message = event.data;
  if (!message || message.type !== "generate") return;

  const { id, options } = message;
  void (async () => {
    try {
      const result = await generateRoadSurface(options);
      const response: GenerationWorkerResponse = {
        type: "result",
        id,
        result,
      };
      self.postMessage(response);
    } catch (error) {
      const response: GenerationWorkerResponse = {
        type: "error",
        id,
        message: error instanceof Error ? error.message : String(error),
      };
      self.postMessage(response);
    }
  })();
};
