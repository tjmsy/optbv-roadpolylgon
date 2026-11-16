import geojsonvt from "geojson-vt";
import type { AddProtocolAction } from "maplibre-gl";
import vtpbf from "vt-pbf";
import { padBboxMeters } from "../core/bbox.js";
import { generateRoadSurface } from "../core/road-surface.js";
import { tileToBbox } from "../core/tile-grid.js";
import type { RoadSurfaceFailure, RoadSurfaceOptions } from "../core/types.js";

const TILE_HALO_METERS = 40;
const DEFAULT_PROTOCOL = "road-surface";
const DEFAULT_SOURCE_LAYER = "road-surface";
const DEFAULT_CACHE_SIZE = 64;

export interface RoadSurfaceProtocolOptions
  extends Omit<RoadSurfaceOptions, "bbox" | "clipToBbox" | "signal"> {
  /** Registered URL scheme without `://`. Defaults to `road-surface`. */
  protocol?: string;
  /** MVT source-layer name used by the MapLibre vector source. */
  sourceLayer?: string;
  /** Maximum number of resolved and in-flight tiles retained in memory. */
  cacheSize?: number;
  /** Called when a tile finishes with a failed quality check. */
  onQualityWarning?: (info: {
    z: number;
    x: number;
    y: number;
    failure?: RoadSurfaceFailure;
  }) => void;
}

export interface RoadSurfaceProtocolRegistration {
  /** URL template for a MapLibre vector source. */
  tiles: string;
  /** Removes the registered MapLibre protocol handler. */
  unregister(): void;
}

type ProtocolHost = Pick<typeof import("maplibre-gl"), "addProtocol" | "removeProtocol">;

function parseTileUrl(url: string): { z: number; x: number; y: number } {
  const match = /^[a-z][a-z\d+.-]*:\/\/(\d+)\/(\d+)\/(\d+)(?:\?.*)?$/i.exec(
    url
  );
  if (!match) throw new Error(`Invalid road surface tile URL: ${url}`);
  const [, zText, xText, yText] = match;
  const z = Number(zText);
  const x = Number(xText);
  const y = Number(yText);
  const dimension = 2 ** z;
  if (
    !Number.isSafeInteger(z) ||
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(y) ||
    z < 0 ||
    z > 22 ||
    x < 0 ||
    y < 0 ||
    x >= dimension ||
    y >= dimension
  ) {
    throw new RangeError(`Tile coordinate out of range: ${z}/${x}/${y}`);
  }
  return { z, x, y };
}

/** Register a generated MVT source backed by the repository's road-surface pipeline. */
export function registerRoadSurfaceProtocol(
  maplibre: ProtocolHost,
  options: RoadSurfaceProtocolOptions = {}
): RoadSurfaceProtocolRegistration {
  const {
    protocol = DEFAULT_PROTOCOL,
    sourceLayer = DEFAULT_SOURCE_LAYER,
    cacheSize = DEFAULT_CACHE_SIZE,
    onQualityWarning,
    ...generationOptions
  } = options;
  if (!/^[a-z][a-z\d+.-]*$/i.test(protocol)) {
    throw new Error(`Invalid protocol name: ${protocol}`);
  }
  if (!Number.isSafeInteger(cacheSize) || cacheSize < 0) {
    throw new RangeError("cacheSize must be a non-negative integer");
  }

  const cache = new Map<string, Promise<ArrayBuffer>>();
  let registered = true;

  const handler: AddProtocolAction = async (params, abortController) => {
    if (!params.url.startsWith(`${protocol}://`)) {
      throw new Error(`Unexpected protocol URL: ${params.url}`);
    }
    const { z, x, y } = parseTileUrl(params.url);
    const key = `${z}/${x}/${y}`;
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return { data: await cached };
    }

    const tileBbox = tileToBbox(z, x, y);
    const workBbox = padBboxMeters(tileBbox, TILE_HALO_METERS);
    const pending = (async () => {
      const result = await generateRoadSurface({
        ...generationOptions,
        bbox: workBbox,
        clipToBbox: tileBbox,
        signal: abortController.signal,
        includeArtifacts: false,
      });
      if (!result.meta.ok) {
        onQualityWarning?.({ z, x, y, failure: result.meta.failure });
      }

      const index = new geojsonvt(result, { maxZoom: z, indexMaxZoom: z });
      const tile = index.getTile(z, x, y) ?? { features: [] };
      const bytes = vtpbf.fromGeojsonVt({ [sourceLayer]: tile }, { version: 2 });
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
    })();

    if (cacheSize > 0) {
      cache.set(key, pending);
      while (cache.size > cacheSize) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }

    try {
      return { data: await pending };
    } catch (error) {
      if (cache.get(key) === pending) cache.delete(key);
      throw error;
    }
  };

  maplibre.addProtocol(protocol, handler);
  return {
    tiles: `${protocol}://{z}/{x}/{y}`,
    unregister() {
      if (!registered) return;
      registered = false;
      maplibre.removeProtocol(protocol);
      cache.clear();
    },
  };
}

