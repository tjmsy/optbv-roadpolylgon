import type { FeatureCollection, LineString, Point, Polygon } from "geojson";

/** 道路面生成パイプラインの中間生成物 ID */
export type PipelineArtifactId =
  | "input-rd-edg"
  | "input-rd-cl"
  | "bbox"
  | "coalesced-rd-edg"
  | "edge-gaps"
  | "dangling-tips"
  | "trust-barriers"
  | "buffered-edges"
  | "merged-buffer"
  | "split-regions"
  | "road-surface"
  | "cl-safe"
  | "cl-provisional"
  | "cl-excluded";

export type PipelineArtifacts = {
  "input-rd-edg": FeatureCollection<LineString>;
  "input-rd-cl": FeatureCollection<LineString>;
  bbox: FeatureCollection<Polygon>;
  "coalesced-rd-edg": FeatureCollection<LineString>;
  "edge-gaps": FeatureCollection<LineString>;
  "dangling-tips": FeatureCollection<Point>;
  "trust-barriers": FeatureCollection<LineString>;
  "buffered-edges": FeatureCollection<Polygon>;
  "merged-buffer": FeatureCollection<Polygon>;
  "split-regions": FeatureCollection<Polygon>;
  "road-surface": FeatureCollection<Polygon>;
  "cl-safe": FeatureCollection<LineString>;
  "cl-provisional": FeatureCollection<LineString>;
  "cl-excluded": FeatureCollection<LineString>;
};
