import type { Position } from "geojson";
import {
  metersPerDegreeLongitude,
  METERS_PER_DEGREE_LATITUDE_BBOX,
} from "./geodesy.js";
import {
  GAP_WORK_BOUNDARY_EPSILON_M,
  type EdgeGapKind,
  type EdgeGapOptions,
} from "./edge-gap-config.js";
import type { Bbox } from "./types.js";

/** Distance from a coordinate to the nearest axis-aligned bbox edge, in meters. */
export function minDistanceToBboxBoundaryM(
  coord: Position,
  bbox: Bbox
): number {
  const [west, south, east, north] = bbox;
  const lon = coord[0]!;
  const lat = coord[1]!;
  const mLon = Math.max(metersPerDegreeLongitude(lat), 1e-6);
  const mLat = METERS_PER_DEGREE_LATITUDE_BBOX;
  return Math.min(
    Math.abs(lon - west) * mLon,
    Math.abs(lon - east) * mLon,
    Math.abs(lat - south) * mLat,
    Math.abs(lat - north) * mLat
  );
}

function endpointOnWorkBboxBoundary(
  coord: Position,
  options: EdgeGapOptions
): boolean {
  if (!options.workBbox) return false;
  const epsilonM = options.workBoundaryEpsilonM ?? GAP_WORK_BOUNDARY_EPSILON_M;
  return minDistanceToBboxBoundaryM(coord, options.workBbox) <= epsilonM;
}

export function blocksBridgeOnWorkBoundary(kind: EdgeGapKind): boolean {
  return kind === "mid-road" || kind === "topology" || kind === "ambiguous";
}

export function isOneSidedWorkBoundaryBridge(
  a: Position,
  b: Position,
  options: EdgeGapOptions
): boolean {
  const aOn = endpointOnWorkBboxBoundary(a, options);
  const bOn = endpointOnWorkBboxBoundary(b, options);
  return aOn !== bOn;
}
