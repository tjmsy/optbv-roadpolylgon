import type { Feature, MultiPolygon, Polygon, Position } from "geojson";

export type PolyFeature = Feature<Polygon | MultiPolygon>;
type PcRing = [number, number][];
type PcPolygon = PcRing[];
type PcMultiPolygon = PcPolygon[];
type PcGeometry = PcPolygon | PcMultiPolygon;

function toPolygonClippingPolygon(coords: Position[][]): PcPolygon {
  return coords.map((ring) =>
    ring.map((position) => [position[0]!, position[1]!] as [number, number])
  );
}

/** Convert GeoJSON Polygon/MultiPolygon coordinates to polygon-clipping shape. */
export function toPolygonClippingGeometry(feature: PolyFeature): PcGeometry {
  if (feature.geometry.type === "Polygon") {
    return toPolygonClippingPolygon(feature.geometry.coordinates);
  }
  return feature.geometry.coordinates.map((polygon) =>
    toPolygonClippingPolygon(polygon)
  );
}

export function asPolygonClippingMultiPolygon(
  geometry: PcGeometry
): PcMultiPolygon {
  const firstCoord = geometry[0]?.[0]?.[0];
  return typeof firstCoord === "number"
    ? [geometry as PcPolygon]
    : (geometry as PcMultiPolygon);
}

/** Convert a polygon-clipping MultiPolygon result back to GeoJSON. */
export function fromPolygonClippingMultiPolygon(
  coordinates: PcMultiPolygon
): PolyFeature | null {
  if (!coordinates || coordinates.length === 0) return null;
  if (coordinates.length === 1) {
    return {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: coordinates[0]! },
    };
  }
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "MultiPolygon", coordinates },
  };
}
