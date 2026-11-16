import {
  cachedTileReader,
  pmtilesTileReader,
  registerMvtUnderzoomProtocol,
  type MaplibreWithProtocol,
} from "ml-mvt-underzoom";
import { PMTiles } from "pmtiles";
import { maplibregl } from "./maplibre.js";
import { RoadSurfaceGenerationController } from "./generation-controller.js";
import { GENERATION_MIN_ZOOM } from "./generation-config.js";
import { boundsToBbox, padBbox } from "../core/bbox.js";
import type { RoadSurfaceResult } from "../core/types.js";

export function startMapApp(): void {
  const optimalBvmap = new PMTiles(
    "https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles"
  );
  registerMvtUnderzoomProtocol(maplibregl as MaplibreWithProtocol, {
    protocol: "optimal-bvmap-underzoom",
    sourceZoom: 16,
    readTile: cachedTileReader(pmtilesTileReader(optimalBvmap)),
    sourceLayers: ["RdEdg", "RdCL"],
  });

  const map = new maplibregl.Map({
    container: "map",
    style: "./style.json",
    center: [135, 35],
    zoom: 16,
    minZoom: 5,
    maxZoom: 18,
    maxBounds: [
      [122, 20],
      [154.2, 46.0],
    ],
    hash: true,
  });

  map.addControl(new maplibregl.NavigationControl(), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }));

  const status = document.querySelector<HTMLElement>("#status")!;
  const surfaceSource = () =>
    map.getSource("road-surface") as maplibregl.GeoJSONSource | undefined;
  const generator = new RoadSurfaceGenerationController();

  function generateCurrentView(): void {
    const zoom = map.getZoom();
    if (zoom < GENERATION_MIN_ZOOM) {
      generator.invalidateInFlight();
      surfaceSource()?.setData({ type: "FeatureCollection", features: [] });
      status.textContent = `道路面の表示にはズーム ${GENERATION_MIN_ZOOM} 以上が必要です`;
      return;
    }

    const viewport = boundsToBbox(map.getBounds());
    const workBbox = padBbox(viewport, 0.1);
    generator.schedule({
      bbox: workBbox,
      clipToBbox: viewport,
      includeArtifacts: false,
      zoomLevel: zoom,
    });
  }

  generator.setHandlers({
    onStarted: () => {
      status.textContent = "道路面を生成中…";
    },
    onSuccess: ({ result }: { result: RoadSurfaceResult }) => {
      surfaceSource()?.setData(result);
      status.textContent = result.meta.ok
        ? `道路面 ${result.meta.polygonCount.toLocaleString()} 件`
        : `道路面 ${result.meta.polygonCount.toLocaleString()} 件（道路縁の未接続箇所があります）`;
    },
    onError: ({ message }) => {
      status.textContent = `道路面を生成できませんでした: ${message}`;
    },
    onSkipped: () => {
      status.textContent = `道路面の表示にはズーム ${GENERATION_MIN_ZOOM} 以上が必要です`;
    },
  });

  map.on("load", generateCurrentView);
  map.on("moveend", generateCurrentView);
  window.addEventListener("beforeunload", () => generator.dispose());
}
