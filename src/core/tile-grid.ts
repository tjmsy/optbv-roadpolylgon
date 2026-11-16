import type { Bbox, TileCoord } from "./types.js";

const TILE_BUFFER = 1;

export function lonLatToTile(lon: number, lat: number, z: number): TileCoord {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { z, x, y };
}

/** Web Mercator tile Y (0…1 fraction of world) → latitude degrees. */
function tileYToLat(yFraction: number): number {
  const n = Math.PI - 2 * Math.PI * yFraction;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** XYZ tile → WGS84 bbox [west, south, east, north]. */
export function tileToBbox(z: number, x: number, y: number): Bbox {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = tileYToLat(y / n);
  const south = tileYToLat((y + 1) / n);
  return [west, south, east, north];
}

export function bboxToTileCoords(bbox: Bbox, z: number): TileCoord[] {
  const [west, south, east, north] = bbox;
  const min = lonLatToTile(west, north, z);
  const max = lonLatToTile(east, south, z);

  const tiles: TileCoord[] = [];
  for (let x = min.x - TILE_BUFFER; x <= max.x + TILE_BUFFER; x++) {
    for (let y = min.y - TILE_BUFFER; y <= max.y + TILE_BUFFER; y++) {
      if (x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) continue;
      tiles.push({ z, x, y });
    }
  }
  return tiles;
}

/**
 * work bbox 取得時に実際に読むタイル群（±TILE_BUFFER）の外接 bbox。
 * 入力地物は work より広いタイル範囲から来る。
 */
export function fetchCoverBbox(bbox: Bbox, z: number): Bbox {
  const tiles = bboxToTileCoords(bbox, z);
  if (tiles.length === 0) return bbox;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const tile of tiles) {
    const [w, s, e, n] = tileToBbox(tile.z, tile.x, tile.y);
    west = Math.min(west, w);
    south = Math.min(south, s);
    east = Math.max(east, e);
    north = Math.max(north, n);
  }
  return [west, south, east, north];
}
