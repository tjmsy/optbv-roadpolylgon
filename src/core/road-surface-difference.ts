import type { Feature, MultiPolygon, Polygon } from "geojson";
import {
  differencePolygonsDetailed,
  type DifferenceAllResult,
} from "./difference-polygons.js";

/** Difference the work bbox against the buffer, retrying dirty union output by parts. */
export function differenceRoadSurfaceWorkArea(
  bboxPolygon: Feature<Polygon>,
  mergedBuffer: Feature<Polygon | MultiPolygon>,
  bufferedEdges: Feature<Polygon>[],
  unionUsedConcat: boolean
): DifferenceAllResult {
  let result = differencePolygonsDetailed(bboxPolygon, mergedBuffer, {
    skipPolygonClipping: unionUsedConcat,
  });

  // A dirty MultiPolygon from the union fallback may fail as a whole. Retry its original parts.
  if (!result.feature && bufferedEdges.length > 0) {
    const buffersAsMultiPolygon: Feature<MultiPolygon> = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "MultiPolygon",
        coordinates: bufferedEdges.map(
          (feature) => feature.geometry.coordinates
        ),
      },
    };
    const retry = differencePolygonsDetailed(
      bboxPolygon,
      buffersAsMultiPolygon,
      { skipPolygonClipping: true }
    );
    if (retry.feature) result = retry;
  }

  return result;
}
