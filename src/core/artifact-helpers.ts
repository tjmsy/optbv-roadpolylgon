import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiPolygon,
  Point,
  Polygon,
} from "geojson";
import { bboxToPolygonRing } from "./bbox.js";
import type { PipelineArtifactId } from "./pipeline-artifacts.js";
import { fetchCoverBbox } from "./tile-fetch.js";
import type { Bbox } from "./types.js";

/** 会話・検査用の短い参照 ID 接頭辞 */
export const ARTIFACT_REF_PREFIX: Record<PipelineArtifactId, string> = {
  "input-rd-edg": "edg",
  "input-rd-cl": "cl",
  bbox: "bb",
  "coalesced-rd-edg": "ced",
  "edge-gaps": "gap",
  "dangling-tips": "tip",
  "trust-barriers": "tbr",
  "buffered-edges": "buf",
  "merged-buffer": "mrg",
  "split-regions": "spl",
  "road-surface": "rd",
  "cl-safe": "cls",
  "cl-provisional": "clp",
  "cl-excluded": "clx",
};

/** `bbox` artifact 内の範囲種別（ビューポートと別系統の判定枠） */
export type BboxExtentRole =
  "work-extent" | "clip-extent" | "quality-extent" | "fetch-extent";

function bboxExtentFeature(
  bbox: Bbox,
  role: BboxExtentRole,
  note: string
): Feature<Polygon> {
  const [west, south, east, north] = bbox;
  return {
    type: "Feature",
    properties: {
      _role: role,
      _note: note,
      west,
      south,
      east,
      north,
    },
    geometry: {
      type: "Polygon",
      coordinates: [bboxToPolygonRing(bbox)],
    },
  };
}

/**
 * 作業・クリップ・品質・タイル取得の各範囲を `bbox` artifact 用に並べる。
 * UI は viewport を `clipToBbox` に、作業は +pad を `bbox` に渡す。
 */
export function buildBboxExtentFeatures(options: {
  workBbox: Bbox;
  clipToBbox?: Bbox;
  fetchZoom: number;
}): Feature<Polygon>[] {
  const { workBbox, clipToBbox, fetchZoom } = options;
  const qualityBbox = clipToBbox ?? workBbox;
  const features: Feature<Polygon>[] = [
    bboxExtentFeature(
      workBbox,
      "work-extent",
      "difference / gaps / selection の作業枠（UI では viewport+10%）"
    ),
  ];
  if (clipToBbox) {
    features.push(
      bboxExtentFeature(
        clipToBbox,
        "clip-extent",
        "最終道路面のクリップ枠（UI では生 viewport / Tile では出力タイル）"
      )
    );
  }
  features.push(
    bboxExtentFeature(
      qualityBbox,
      "quality-extent",
      "spill-edge-sides / dangling-tips の品質判定枠（clip があれば clip、なければ work）"
    )
  );
  features.push(
    bboxExtentFeature(
      fetchCoverBbox(workBbox, fetchZoom),
      "fetch-extent",
      "MVT 取得タイル外接（work ±1 タイル）。入力縁はここから work へクリップ"
    )
  );
  return features;
}

export function artifactRef(
  artifact: PipelineArtifactId,
  index: number
): string {
  return `${ARTIFACT_REF_PREFIX[artifact]}-${index}`;
}

export function tagArtifactFeatures<
  G extends LineString | Polygon | Point,
  T extends Feature<G>,
>(features: T[], artifact: PipelineArtifactId, step: number): T[] {
  return features.map((feature, index) => ({
    ...feature,
    properties: {
      ...feature.properties,
      _artifact: artifact,
      _step: step,
      _index: index,
      _ref: artifactRef(artifact, index),
    },
  }));
}

export function toFeatureCollection<G extends LineString | Polygon | Point>(
  features: Feature<G>[]
): FeatureCollection<G> {
  return { type: "FeatureCollection", features };
}

export function polygonFeaturesFromUnionResult(
  feature: Feature<Polygon | MultiPolygon> | null,
  artifact: PipelineArtifactId,
  step: number
): FeatureCollection<Polygon> {
  if (!feature) {
    return { type: "FeatureCollection", features: [] };
  }

  if (feature.geometry.type === "Polygon") {
    return toFeatureCollection(
      tagArtifactFeatures([feature as Feature<Polygon>], artifact, step)
    );
  }

  if (feature.geometry.type === "MultiPolygon") {
    const polygons: Feature<Polygon>[] = [];
    for (const [
      polyIndex,
      polyCoords,
    ] of feature.geometry.coordinates.entries()) {
      polygons.push({
        type: "Feature",
        properties: {
          ...feature.properties,
          _artifact: artifact,
          _step: step,
          _polyIndex: polyIndex,
          _index: polyIndex,
          _ref: artifactRef(artifact, polyIndex),
        },
        geometry: { type: "Polygon", coordinates: polyCoords },
      });
    }
    return toFeatureCollection(polygons);
  }

  return { type: "FeatureCollection", features: [] };
}
