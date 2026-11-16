import type { RoadSurfaceOptions, RoadSurfaceResult } from "../core/types.js";

export type GenerationRequest = {
  type: "generate";
  id: number;
  options: RoadSurfaceOptions;
};

export type GenerationSuccess = {
  type: "result";
  id: number;
  result: RoadSurfaceResult;
};

export type GenerationFailure = {
  type: "error";
  id: number;
  message: string;
};

export type GenerationWorkerResponse = GenerationSuccess | GenerationFailure;
