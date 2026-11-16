import {
  buildBboxExtentFeatures,
  polygonFeaturesFromUnionResult,
  tagArtifactFeatures,
  toFeatureCollection,
} from "./artifact-helpers.js";
import type { Feature, MultiPolygon, Point, Polygon } from "geojson";
import type { DanglingOpeningTip } from "./edge-gaps.js";
import { emptyPipelineArtifacts } from "./pipeline-artifacts.js";
import type { Bbox, LineFeature } from "./types.js";
import type { PipelineArtifacts } from "./pipeline-artifacts.js";
import {
  buildDanglingTipFeatures,
  type SpillEdgeSidesHit,
} from "./spill-edge-sides.js";

type BuildFinalArtifactsOptions = {
  includeArtifacts: boolean;
  skipSpillCheck: boolean;
  gapEdges: LineFeature[];
  qualityBbox: Bbox;
  spillHits: SpillEdgeSidesHit[];
  danglingTips: DanglingOpeningTip[];
  outputPolygons: Feature<Polygon>[];
  splitPolygons: Feature<Polygon>[];
};

type BuildInvestigationArtifactsOptions = {
  includeArtifacts: boolean;
  edges: LineFeature[];
  centerlines: LineFeature[];
  bbox: Bbox;
  clipToBbox?: Bbox;
  zoom: number;
  coalescedEdges: LineFeature[];
  gapFeatures: LineFeature[];
  barriers: LineFeature[];
  bufferedEdges: Feature<Polygon>[];
  mergedBuffer: Feature<Polygon | MultiPolygon> | null;
  safeCenterlines: LineFeature[];
  provisionalCenterlines: LineFeature[];
  excludedCenterlines: LineFeature[];
};

/** Build optional intermediate feature collections used to inspect generation stages. */
export function buildInvestigationArtifacts(
  options: BuildInvestigationArtifactsOptions
): Partial<PipelineArtifacts> {
  if (!options.includeArtifacts) return {};

  const {
    edges,
    centerlines,
    bbox,
    clipToBbox,
    zoom,
    coalescedEdges,
    gapFeatures,
    barriers,
    bufferedEdges,
    mergedBuffer,
    safeCenterlines,
    provisionalCenterlines,
    excludedCenterlines,
  } = options;

  return {
    "input-rd-edg": toFeatureCollection(
      tagArtifactFeatures(edges, "input-rd-edg", 1)
    ),
    "input-rd-cl": toFeatureCollection(
      tagArtifactFeatures(centerlines, "input-rd-cl", 2)
    ),
    bbox: toFeatureCollection(
      tagArtifactFeatures(
        buildBboxExtentFeatures({
          workBbox: bbox,
          clipToBbox,
          fetchZoom: zoom,
        }),
        "bbox",
        3
      )
    ),
    "coalesced-rd-edg": toFeatureCollection(
      tagArtifactFeatures(coalescedEdges, "coalesced-rd-edg", 4)
    ),
    "edge-gaps": toFeatureCollection(
      tagArtifactFeatures(gapFeatures, "edge-gaps", 5)
    ),
    "trust-barriers": toFeatureCollection(
      tagArtifactFeatures(barriers, "trust-barriers", 7)
    ),
    "buffered-edges": toFeatureCollection(
      tagArtifactFeatures(bufferedEdges, "buffered-edges", 8)
    ),
    "merged-buffer": polygonFeaturesFromUnionResult(
      mergedBuffer,
      "merged-buffer",
      9
    ),
    "cl-safe": toFeatureCollection(
      tagArtifactFeatures(safeCenterlines, "cl-safe", 12)
    ),
    "cl-provisional": toFeatureCollection(
      tagArtifactFeatures(provisionalCenterlines, "cl-provisional", 13)
    ),
    "cl-excluded": toFeatureCollection(
      tagArtifactFeatures(excludedCenterlines, "cl-excluded", 14)
    ),
  };
}

export function buildFinalRoadSurfaceArtifacts(
  options: BuildFinalArtifactsOptions
): { artifacts: PipelineArtifacts; features: Feature<Polygon>[] } {
  const {
    includeArtifacts,
    skipSpillCheck,
    gapEdges,
    qualityBbox,
    spillHits,
    danglingTips,
    outputPolygons,
    splitPolygons,
  } = options;

  const roadSurface = toFeatureCollection(
    tagArtifactFeatures(outputPolygons, "road-surface", 11)
  );
  const danglingTipsArtifact = skipSpillCheck
    ? toFeatureCollection([] as Feature<Point>[])
    : toFeatureCollection(
        tagArtifactFeatures(
          buildDanglingTipFeatures(gapEdges, qualityBbox, spillHits, {
            danglingTips,
          }),
          "dangling-tips",
          6
        )
      );

  const artifacts: PipelineArtifacts = {
    ...emptyPipelineArtifacts(),
    "dangling-tips": danglingTipsArtifact,
    "road-surface": roadSurface,
    ...(includeArtifacts
      ? {
          "split-regions": toFeatureCollection(
            tagArtifactFeatures(splitPolygons, "split-regions", 10)
          ),
        }
      : { "split-regions": toFeatureCollection([] as Feature<Polygon>[]) }),
  };

  return { artifacts, features: roadSurface.features };
}
