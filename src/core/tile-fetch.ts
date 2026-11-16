import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { PMTiles } from "pmtiles";
import {
  GSI_OPTIMAL_BVMAP_PMTILES,
  type FetchLayerFeaturesOptions,
  type FetchLayerFeaturesResult,
  type LineFeature,
  type TileCoord,
} from "./types.js";
import { bboxToTileCoords } from "./tile-grid.js";
export {
  bboxToTileCoords,
  fetchCoverBbox,
  lonLatToTile,
  tileToBbox,
} from "./tile-grid.js";

const pmtilesCache = new Map<string, PMTiles>();

/** デコード済みタイル地物の LRU 風キャッシュ（パン時の再デコード回避） */
const DECODED_TILE_CACHE_MAX = 96;
const decodedTileCache = new Map<string, Record<string, LineFeature[]>>();

function getPmtiles(url: string): PMTiles {
  let instance = pmtilesCache.get(url);
  if (!instance) {
    instance = new PMTiles(url);
    pmtilesCache.set(url, instance);
  }
  return instance;
}

function decodedTileCacheKey(
  pmtilesUrl: string,
  tile: TileCoord,
  layerNames: string[]
): string {
  return `${pmtilesUrl}|${tile.z}/${tile.x}/${tile.y}|${layerNames.join(",")}`;
}

function rememberDecodedTile(
  key: string,
  layers: Record<string, LineFeature[]>
): void {
  if (decodedTileCache.has(key)) decodedTileCache.delete(key);
  decodedTileCache.set(key, layers);
  while (decodedTileCache.size > DECODED_TILE_CACHE_MAX) {
    const oldest = decodedTileCache.keys().next().value;
    if (oldest == null) break;
    decodedTileCache.delete(oldest);
  }
}

import {
  clipLineFeatureToBbox,
  decodeLayerFeature,
  dedupeLineFeatures,
} from "./tile-feature-processing.js";
export {
  clipLineFeatureToBbox,
  clipLineFeaturesToBbox,
  decodeLayerFeature,
  dedupeLineFeatures,
} from "./tile-feature-processing.js";
async function fetchTileLayers(
  pmtiles: PMTiles,
  tile: TileCoord,
  layerNames: string[],
  cacheKey: string
): Promise<Record<string, LineFeature[]>> {
  const cached = decodedTileCache.get(cacheKey);
  if (cached) {
    // LRU: 再挿入
    rememberDecodedTile(cacheKey, cached);
    return cached;
  }

  const result: Record<string, LineFeature[]> = Object.fromEntries(
    layerNames.map((name) => [name, []])
  );

  const response = await pmtiles.getZxy(tile.z, tile.x, tile.y);
  if (!response?.data) {
    rememberDecodedTile(cacheKey, result);
    return result;
  }

  const vectorTile = new VectorTile(new PbfReader(response.data));

  for (const layerName of layerNames) {
    const layer = vectorTile.layers[layerName];
    if (!layer) continue;

    for (let i = 0; i < layer.length; i++) {
      const lines = decodeLayerFeature(layer.feature(i), tile);
      result[layerName].push(...lines);
    }
  }

  rememberDecodedTile(cacheKey, result);
  return result;
}

export async function fetchLayerFeatures(
  options: FetchLayerFeaturesOptions
): Promise<FetchLayerFeaturesResult> {
  const {
    bbox,
    zoom,
    layers,
    pmtilesUrl = GSI_OPTIMAL_BVMAP_PMTILES,
    pmtilesResolver,
  } = options;

  const pmtiles = pmtilesResolver
    ? pmtilesResolver(pmtilesUrl)
    : getPmtiles(pmtilesUrl);
  const tiles = bboxToTileCoords(bbox, zoom);
  const merged: Record<string, LineFeature[]> = Object.fromEntries(
    layers.map((name) => [name, []])
  );
  const processedTiles: string[] = [];

  const tileResults = await Promise.all(
    tiles.map(async (tile) => {
      const cacheKey = decodedTileCacheKey(pmtilesUrl, tile, layers);
      const tileLayers = await fetchTileLayers(pmtiles, tile, layers, cacheKey);
      return { tile, tileLayers };
    })
  );

  for (const { tile, tileLayers } of tileResults) {
    processedTiles.push(`${tile.z}/${tile.x}/${tile.y}`);

    for (const layerName of layers) {
      for (const feature of tileLayers[layerName] ?? []) {
        const clipped = clipLineFeatureToBbox(feature, bbox);
        merged[layerName].push(...clipped);
      }
    }
  }

  for (const layerName of layers) {
    merged[layerName] = dedupeLineFeatures(merged[layerName]);
  }

  return { layers: merged, processedTiles };
}

/** テスト用: デコードキャッシュを空にする */
export function clearDecodedTileCache(): void {
  decodedTileCache.clear();
}
