# 最適化ベクトルタイル道路面

国土地理院最適化ベクトルタイル（RdEdg / RdCL）から道路面ポリゴンを生成し、背景地図とともに表示します。地図を移動・ズームすると、表示範囲に合わせて道路面を自動で再生成します。

## 起動

```sh
npm install
npm run dev
```

道路面と道路縁はズーム 15 以上で表示します。最適化ベクトルタイルに収録された z16 データを z15 表示用に合成します。

## 表示データ

- 背景: 国土地理院 地理院タイル（淡色地図）
- 道路縁と道路面生成入力: 国土地理院 最適化ベクトルタイル（RdEdg / RdCL）
- 道路面: ブラウザー内で RdEdg と RdCL から生成

地理院タイルの利用にあたっては[地理院タイル一覧](https://maps.gsi.go.jp/development/ichiran.html)および各データの利用条件を確認してください。地図上に国土地理院への出典を表示します。

## 技術

MapLibre GL JS で地図を表示し、Web Worker 上で Turf.js による道路面生成を行います。生成コアは `src/core/`、地図画面と生成制御は `src/client/` と `src/main.ts` にあります。

## GitHub 依存として利用する

このリポジトリは npm registry に公開せず、GitHub URL を指定して追加できます。

```sh
npm install github:tjmsy/optbv-roadpolylgon
```

パッケージの `prepare` script が TypeScript のライブラリ entry と型宣言をビルドします。MapLibre GL JS は peer dependency なので、利用側のアプリでもインストールしてください。

```ts
import * as maplibregl from "maplibre-gl";
import { registerRoadSurfaceProtocol } from "optbv-roadpolylgon";

const roadSurface = registerRoadSurfaceProtocol(maplibregl, {
  pmtilesUrl:
    "https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles",
  onQualityWarning: ({ z, x, y, failure }) => {
    console.warn(`道路面タイル ${z}/${x}/${y} の品質警告`, failure);
  },
});

map.addSource("road-surface", {
  type: "vector",
  tiles: [roadSurface.tiles],
  minzoom: 15,
  maxzoom: 16,
});
map.addLayer({
  id: "road-surface-fill",
  type: "fill",
  source: "road-surface",
  "source-layer": "road-surface",
  paint: { "fill-color": "#d9c8a9", "fill-opacity": 0.8 },
});

// map を破棄するとき
roadSurface.unregister();
```

protocol は各 XYZ 要求に MVT を返します。タイルの bbox は内部で計算し、40 m の演算余白を付けて道路面を生成した後に要求タイルへ切り出します。タイル結果は登録単位で最大 64 件をメモリに保持します。別の最大数が必要な場合は `cacheSize` を指定してください。protocol の登録名を変える場合は `protocol`、MVT source-layer 名を変える場合は `sourceLayer` を指定し、MapLibre source/layer 側も同じ名前にしてください。

利用例は MapLibre のブラウザーアプリを想定しています。道路面生成は protocol handler 内で実行されるため、表示範囲や端末によってはタイル初回要求時に時間がかかることがあります。地理院最適化ベクトルタイルの利用条件は利用者側で確認してください。
