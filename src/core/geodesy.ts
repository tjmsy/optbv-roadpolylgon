/** Approximate latitude-degree scales retained by existing geometry operations. */
export const METERS_PER_DEGREE_LATITUDE = 110_574;
export const METERS_PER_DEGREE_LATITUDE_BBOX = 110_540;
export const METERS_PER_DEGREE_LONGITUDE_EQUATOR = 111_320;

/** Longitude scale at a given latitude for local equirectangular calculations. */
export function metersPerDegreeLongitude(latitudeDeg: number): number {
  return (
    METERS_PER_DEGREE_LONGITUDE_EQUATOR *
    Math.cos((latitudeDeg * Math.PI) / 180)
  );
}

/** Local east/north vector using the segment's mean latitude. */
type Coordinate2D = readonly number[];

export function localVectorMeters(
  from: Coordinate2D,
  to: Coordinate2D
): [eastM: number, northM: number] {
  const meanLatitude = (from[1]! + to[1]!) / 2;
  return [
    (to[0]! - from[0]!) * metersPerDegreeLongitude(meanLatitude),
    (to[1]! - from[1]!) * METERS_PER_DEGREE_LATITUDE,
  ];
}

/** Local east/north vector using a fixed origin latitude (for point-to-line projections). */
export function localVectorMetersAtLatitude(
  from: Coordinate2D,
  to: Coordinate2D,
  latitudeDeg: number = from[1]
): [eastM: number, northM: number] {
  return [
    (to[0]! - from[0]!) * metersPerDegreeLongitude(latitudeDeg),
    (to[1]! - from[1]!) * METERS_PER_DEGREE_LATITUDE,
  ];
}

/** Offset a coordinate with the shared local equirectangular projection. */
export function offsetLocalMeters(
  origin: Coordinate2D,
  eastM: number,
  northM: number
): [longitude: number, latitude: number] {
  return [
    origin[0]! + eastM / metersPerDegreeLongitude(origin[1]!),
    origin[1]! + northM / METERS_PER_DEGREE_LATITUDE,
  ];
}

/** Great-circle distance between two WGS84 coordinates, in meters. */
export function haversineMeters(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number
): number {
  const earthRadiusMeters = 6_371_000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLon = toRadians(lon2 - lon1);
  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(deltaLon / 2) ** 2;
  // Floating-point rounding can push the value a few ulps outside [0, 1],
  // which otherwise turns coincident/antipodal distances into NaN.
  const boundedHaversine = Math.min(1, Math.max(0, haversine));
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(boundedHaversine));
}

/** Convert a meter radius to a conservative degree padding using 110,574 m/° latitude. */
export function metersToDegPad(meters: number, latDeg: number): number {
  const mLon = Math.max(metersPerDegreeLongitude(latDeg), 1e-6);
  return Math.max(meters / METERS_PER_DEGREE_LATITUDE, meters / mLon);
}

/** Convert a meter radius to degree padding using the square local projection (111,320 m/°). */
export function metersToSquareProjectionDegPad(
  meters: number,
  latDeg: number
): number {
  const mLon = Math.max(metersPerDegreeLongitude(latDeg), 1e-6);
  return Math.max(meters / METERS_PER_DEGREE_LONGITUDE_EQUATOR, meters / mLon);
}

/** Degree padding used by bbox helpers (keeps their 110,540 m/° approximation). */
export function metersToBboxDegreePads(
  meters: number,
  latitudeDeg: number,
  minimumCosLatitude = 0.01
): { longitude: number; latitude: number } {
  const cosLatitude = Math.max(
    Math.cos((latitudeDeg * Math.PI) / 180),
    minimumCosLatitude
  );
  return {
    longitude: meters / (METERS_PER_DEGREE_LONGITUDE_EQUATOR * cosLatitude),
    latitude: meters / METERS_PER_DEGREE_LATITUDE_BBOX,
  };
}
