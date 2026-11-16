import bboxClip from "@turf/bbox-clip";
import type { Position } from "geojson";
import type { Bbox, LineFeature, TileCoord } from "./types.js";

/**
 * MVT フィーチャを LineString 群に展開する。
 * MultiLineString は全 part を個別の LineString にする。
 */
export function decodeLayerFeature(
  feature: { toGeoJSON: (x: number, y: number, z: number) => GeoJSON.Feature },
  tile: TileCoord
): LineFeature[] {
  const geojson = feature.toGeoJSON(tile.x, tile.y, tile.z);
  const props = geojson.properties ?? {};

  if (geojson.geometry.type === "LineString") {
    if (geojson.geometry.coordinates.length < 2) return [];
    return [
      {
        type: "Feature",
        properties: props,
        geometry: geojson.geometry,
      },
    ];
  }

  if (geojson.geometry.type === "MultiLineString") {
    const lines: LineFeature[] = [];
    for (const [partIndex, part] of geojson.geometry.coordinates.entries()) {
      if (!part || part.length < 2) continue;
      lines.push({
        type: "Feature",
        properties: {
          ...props,
          _multiPartIndex: partIndex,
        },
        geometry: {
          type: "LineString",
          coordinates: part,
        },
      });
    }
    return lines;
  }

  return [];
}

/**
 * LineString を bbox で厳密にクリップする。
 * 交差するが頂点がすべて外にある線も、内部セグメントが残る。
 */
export function clipLineFeatureToBbox(
  feature: LineFeature,
  bbox: Bbox
): LineFeature[] {
  try {
    const clipped = bboxClip(feature, bbox);
    if (!clipped?.geometry) return [];

    if (clipped.geometry.type === "LineString") {
      if (clipped.geometry.coordinates.length < 2) return [];
      return [
        {
          type: "Feature",
          properties: feature.properties ?? {},
          geometry: clipped.geometry,
        },
      ];
    }

    if (clipped.geometry.type === "MultiLineString") {
      const lines: LineFeature[] = [];
      for (const part of clipped.geometry.coordinates) {
        if (!part || part.length < 2) continue;
        lines.push({
          type: "Feature",
          properties: feature.properties ?? {},
          geometry: { type: "LineString", coordinates: part },
        });
      }
      return lines;
    }
  } catch {
    return [];
  }

  return [];
}

/** 複数 LineString を bbox で厳密クリップし、隣接タイル由来の重複を除去する。 */
export function clipLineFeaturesToBbox(
  features: LineFeature[],
  bbox: Bbox
): LineFeature[] {
  return dedupeLineFeatures(
    features.flatMap((feature) => clipLineFeatureToBbox(feature, bbox))
  );
}

function roundCoord(coord: Position, digits = 7): string {
  return `${coord[0].toFixed(digits)},${coord[1].toFixed(digits)}`;
}

/** 隣接タイル由来の同一線分を除去する */
export function dedupeLineFeatures(features: LineFeature[]): LineFeature[] {
  const seen = new Set<string>();
  const result: LineFeature[] = [];

  for (const feature of features) {
    const coords = feature.geometry.coordinates;
    const forward = coords.map((c) => roundCoord(c)).join(";");
    const reverse = [...coords]
      .reverse()
      .map((c) => roundCoord(c))
      .join(";");
    const key = forward < reverse ? forward : reverse;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(feature);
  }

  return result;
}
