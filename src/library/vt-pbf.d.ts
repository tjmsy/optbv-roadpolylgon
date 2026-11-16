declare module "vt-pbf" {
  import type { LegacyTile } from "geojson-vt";

  interface VectorTilePbf {
    fromGeojsonVt(
      layers: Record<string, LegacyTile>,
      options?: { version?: number; extent?: number }
    ): Uint8Array;
  }

  const vtpbf: VectorTilePbf;
  export default vtpbf;
}
