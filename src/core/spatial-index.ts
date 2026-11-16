/**
 * 軽量 bbox 空間インデックス。
 * Turf の booleanIntersects / lineIntersect / PIP の前段剪定用（外部依存なし）。
 */
import type { Feature, LineString, Polygon, Position } from "geojson";
import type { LineFeature } from "./types.js";

export type BBox4 = [minX: number, minY: number, maxX: number, maxY: number];

export function bboxesOverlap(a: BBox4, b: BBox4, pad = 0): boolean {
  return !(
    a[2] + pad < b[0] ||
    b[2] + pad < a[0] ||
    a[3] + pad < b[1] ||
    b[3] + pad < a[1]
  );
}

export function pointInBBox(
  x: number,
  y: number,
  box: BBox4,
  pad = 0
): boolean {
  return (
    x >= box[0] - pad &&
    x <= box[2] + pad &&
    y >= box[1] - pad &&
    y <= box[3] + pad
  );
}

export function expandBBox(box: BBox4, pad: number): BBox4 {
  if (pad === 0) return box;
  return [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
}

/** 座標列の軸平行 bbox（空ならゼロ領域） */
export function coordsBBox(coords: Position[]): BBox4 {
  if (coords.length === 0) return [0, 0, 0, 0];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of coords) {
    const x = c[0]!;
    const y = c[1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

export function lineFeatureBBox(feature: Feature<LineString>): BBox4 {
  return coordsBBox(feature.geometry.coordinates);
}

export function polygonFeatureBBox(feature: Feature<Polygon>): BBox4 {
  const ring = feature.geometry.coordinates[0] ?? [];
  return coordsBBox(ring);
}

type Indexed<T> = { bbox: BBox4; value: T };

/**
 * 線形スキャンの bbox インデックス。
 * ビューポート規模（数百件）では Turf 呼び出し削減が支配的で十分速い。
 */
export class BBoxIndex<T> {
  private readonly items: Indexed<T>[] = [];

  static fromLineFeatures(lines: LineFeature[]): BBoxIndex<LineFeature> {
    const index = new BBoxIndex<LineFeature>();
    for (const line of lines) {
      index.insert(lineFeatureBBox(line), line);
    }
    return index;
  }

  static fromPolygons(
    polygons: Feature<Polygon>[]
  ): BBoxIndex<Feature<Polygon>> {
    const index = new BBoxIndex<Feature<Polygon>>();
    for (const poly of polygons) {
      index.insert(polygonFeatureBBox(poly), poly);
    }
    return index;
  }

  get size(): number {
    return this.items.length;
  }

  insert(bbox: BBox4, value: T): void {
    this.items.push({ bbox, value });
  }

  search(query: BBox4, pad = 0): T[] {
    const out: T[] = [];
    for (const item of this.items) {
      if (bboxesOverlap(query, item.bbox, pad)) out.push(item.value);
    }
    return out;
  }

  /** 点が bbox 内に入る候補（PIP 前段） */
  searchPoint(x: number, y: number, pad = 0): T[] {
    const out: T[] = [];
    for (const item of this.items) {
      if (pointInBBox(x, y, item.bbox, pad)) out.push(item.value);
    }
    return out;
  }
}

/**
 * 点の一様グリッド。近傍端点探索（ギャップ橋）用。
 * cellSizeDeg はスキャン半径（度）程度にすると 1〜数セルで足りる。
 */
export class PointGridIndex<T> {
  private readonly cells = new Map<
    string,
    Array<{ x: number; y: number; value: T }>
  >();
  private readonly cellSize: number;

  constructor(cellSizeDeg: number) {
    this.cellSize = Math.max(cellSizeDeg, 1e-9);
  }

  private key(ix: number, iy: number): string {
    return `${ix},${iy}`;
  }

  insert(x: number, y: number, value: T): void {
    const ix = Math.floor(x / this.cellSize);
    const iy = Math.floor(y / this.cellSize);
    const k = this.key(ix, iy);
    const list = this.cells.get(k);
    if (list) list.push({ x, y, value });
    else this.cells.set(k, [{ x, y, value }]);
  }

  /** 半径 radiusDeg（度）以内の候補（円ではなくチェビシェフ近傍） */
  searchRadius(x: number, y: number, radiusDeg: number): T[] {
    const r = Math.max(radiusDeg, 0);
    const i0 = Math.floor((x - r) / this.cellSize);
    const i1 = Math.floor((x + r) / this.cellSize);
    const j0 = Math.floor((y - r) / this.cellSize);
    const j1 = Math.floor((y + r) / this.cellSize);
    const out: T[] = [];
    const r2 = r * r;
    for (let ix = i0; ix <= i1; ix++) {
      for (let iy = j0; iy <= j1; iy++) {
        const list = this.cells.get(this.key(ix, iy));
        if (!list) continue;
        for (const item of list) {
          const dx = item.x - x;
          const dy = item.y - y;
          if (dx * dx + dy * dy <= r2) out.push(item.value);
        }
      }
    }
    return out;
  }
}
