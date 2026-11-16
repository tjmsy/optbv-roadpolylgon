/**
 * MapLibre GL JS v6 + Vite: worker must be bundled via `?worker&url`.
 * Without this, Vite prebundle resolves `./maplibre-gl-worker.mjs` under
 * `.vite/deps/` (missing file → empty MIME → no tile requests).
 * Import this module **statically** — a dynamic `import()` also dynamic-imports
 * the CSS and Firefox fails on `/node_modules/maplibre-gl/dist/maplibre-gl.css`.
 * @see https://maplibre.org/maplibre-gl-js/docs/#vite
 */
import "maplibre-gl/dist/maplibre-gl.css";
import * as maplibregl from "maplibre-gl";
import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(workerUrl);

export { maplibregl, setWorkerUrl };
