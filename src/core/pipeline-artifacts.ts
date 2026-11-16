import type { FeatureCollection, LineString, Point, Polygon } from "geojson";
import type { PipelineArtifacts } from "./pipeline-artifact-types.js";
export * from "./pipeline-artifact-types.js";

export function emptyPipelineArtifacts(): PipelineArtifacts {
  const empty = <
    G extends LineString | Polygon | Point,
  >(): FeatureCollection<G> => ({
    type: "FeatureCollection",
    features: [],
  });
  return {
    "input-rd-edg": empty<LineString>(),
    "input-rd-cl": empty<LineString>(),
    bbox: empty<Polygon>(),
    "coalesced-rd-edg": empty<LineString>(),
    "edge-gaps": empty<LineString>(),
    "dangling-tips": empty<Point>(),
    "trust-barriers": empty<LineString>(),
    "buffered-edges": empty<Polygon>(),
    "merged-buffer": empty<Polygon>(),
    "split-regions": empty<Polygon>(),
    "road-surface": empty<Polygon>(),
    "cl-safe": empty<LineString>(),
    "cl-provisional": empty<LineString>(),
    "cl-excluded": empty<LineString>(),
  };
}
