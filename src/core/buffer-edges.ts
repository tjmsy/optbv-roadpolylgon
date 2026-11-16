import buffer from "@turf/buffer";
import flatten from "@turf/flatten";
import { featureCollection } from "@turf/helpers";
import type { Feature, Polygon } from "geojson";
import {
  emptyBufferDiagnostics,
  type BufferEdgeDiagnostics,
  type BufferEdgesOptions,
  type LineFeature,
} from "./buffer-config.js";

function defaultLog(message: string, detail?: unknown): void {
  if (detail !== undefined) {
    console.warn(`[buffer-edges] ${message}`, detail);
  } else {
    console.warn(`[buffer-edges] ${message}`);
  }
}

/**
 * 道路縁 LineString 群をバッファし、Polygon 配列を返す。
 * MultiPolygon は flatten して採用。undefined / 例外は diagnostics に記録。
 */
export function bufferEdgeFeatures(
  edges: LineFeature[],
  options: BufferEdgesOptions
): { polygons: Feature<Polygon>[]; diagnostics: BufferEdgeDiagnostics } {
  const diagnostics = emptyBufferDiagnostics(edges.length);
  const polygons: Feature<Polygon>[] = [];
  const log = options.debug ? (options.log ?? defaultLog) : undefined;

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    try {
      const buffered = buffer(edge, options.distanceMeters, {
        units: "meters",
      });

      if (!buffered) {
        diagnostics.undefinedResult++;
        log?.("buffer returned undefined", {
          index: i,
          properties: edge.properties,
          coordinateCount: edge.geometry.coordinates.length,
        });
        continue;
      }

      if (buffered.geometry.type === "Polygon") {
        polygons.push(buffered as Feature<Polygon>);
        continue;
      }

      if (buffered.geometry.type === "MultiPolygon") {
        diagnostics.multipolygonExpanded++;
        const parts = flatten(featureCollection([buffered]));
        let partCount = 0;
        for (const part of parts.features) {
          if (part.geometry.type === "Polygon") {
            polygons.push(part as Feature<Polygon>);
            partCount++;
          }
        }
        log?.("buffer returned MultiPolygon; flattened", {
          index: i,
          parts: partCount,
          properties: edge.properties,
        });
        continue;
      }

      diagnostics.unsupportedGeometry++;
      log?.("buffer returned unsupported geometry", {
        index: i,
        type: (buffered.geometry as { type: string }).type,
        properties: edge.properties,
      });
    } catch (error) {
      diagnostics.exception++;
      log?.("buffer threw", {
        index: i,
        error: error instanceof Error ? error.message : String(error),
        properties: edge.properties,
      });
    }
  }

  diagnostics.acceptedPolygons = polygons.length;
  return { polygons, diagnostics };
}
