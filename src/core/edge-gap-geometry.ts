import type { Position } from "geojson";
import { haversineMeters } from "./geodesy.js";

export const GAP_GID_COORD_DECIMALS = 6;

export function edgeLengthMeters(coords: Position[]): number {
  let length = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i]!;
    const b = coords[i + 1]!;
    length += haversineMeters(a[0]!, a[1]!, b[0]!, b[1]!);
  }
  return length;
}

export function roundGapCoord(
  value: number,
  decimals = GAP_GID_COORD_DECIMALS
): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function edgeGapStableId(
  kind: string,
  a: Position,
  b: Position
): string {
  const midLon = roundGapCoord((a[0]! + b[0]!) / 2);
  const midLat = roundGapCoord((a[1]! + b[1]!) / 2);
  return `g:${kind}@${midLon.toFixed(GAP_GID_COORD_DECIMALS)},${midLat.toFixed(GAP_GID_COORD_DECIMALS)}`;
}

export function edgeGapMid(
  a: Position,
  b: Position
): { midLon: number; midLat: number } {
  return {
    midLon: roundGapCoord((a[0]! + b[0]!) / 2),
    midLat: roundGapCoord((a[1]! + b[1]!) / 2),
  };
}

export function bearingDegrees(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const φ1 = toRadians(lat1);
  const φ2 = toRadians(lat2);
  const Δλ = toRadians(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

export function acuteAngleDifferenceDeg(a: number, b: number): number {
  let difference = Math.abs(a - b) % 180;
  if (difference < 0) difference += 180;
  if (difference > 90) difference = 180 - difference;
  return difference;
}
