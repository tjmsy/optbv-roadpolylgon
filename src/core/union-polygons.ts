/**
 * バッファポリゴンの結合。
 * bbox 連結成分ごとに polygon-clipping union（チャンク + 再帰分割）。
 * PC 失敗・部分欠落時は missing rescue / MultiPolygon 連結。Turf 分割統治は使わない。
 *
 * coverage 判定は booleanIntersects による完全消失検知のみ（部分欠落は見ない）。
 * MultiPolygon 結果に対しては部品 bbox で候補を絞り、全件×全体の交差は避ける。
 */
import type { Feature, MultiPolygon, Polygon } from "geojson";

import {
  bboxesOverlap,
  concatMultiPolygon,
  featureBbox,
  sortSpatially,
  tryPcMergeFeatures,
  tryPcUnionLeaves,
  uncoveredInputs,
  unionResultTouchesAllInputs,
  type PolyFeature,
} from "./union-geometry.js";
export { setPcUnionForTests } from "./union-geometry.js";
export type { PcUnionFn } from "./union-geometry.js";
type UnionStats = {
  usedConcat: boolean;
  usedRecursive: boolean;
  pcRecoveries: number;
  concatParts: number;
};

function emptyStats(): UnionStats {
  return {
    usedConcat: false,
    usedRecursive: false,
    pcRecoveries: 0,
    concatParts: 0,
  };
}

function mergeStats(into: UnionStats, from: UnionStats): void {
  into.usedConcat = into.usedConcat || from.usedConcat;
  into.usedRecursive = into.usedRecursive || from.usedRecursive;
  into.pcRecoveries += from.pcRecoveries;
  into.concatParts += from.concatParts;
}

/**
 * 連結成分（葉ポリゴン）を必ずカバーする Feature を返す。
 * 進行保証: n<=1 は PC 再試行しない。missing は真に小さいときだけ再帰。
 */
function unionGroupRobust(
  leaves: Feature<Polygon>[],
  stats: UnionStats
): PolyFeature | null {
  if (leaves.length === 0) return null;
  // 基底: 単葉は PC 再試行せずそのまま返す（不正形でも進行する）。
  if (leaves.length === 1) return leaves[0] ?? null;

  const pc = tryPcUnionLeaves(leaves);
  if (pc) {
    const missing = uncoveredInputs(pc, leaves);
    if (missing.length === 0) return pc;

    // partial drop: missing が真に小さいときだけ再帰 rescue
    if (missing.length < leaves.length) {
      stats.usedRecursive = true;
      stats.pcRecoveries++;
      const rescued = unionGroupRobust(missing, stats);
      const other = rescued ?? mergeComponentResults(missing);
      if (!other) return pc;
      // concat の前に PC 再結合を試す（成功すれば dirty MultiPolygon を避けられる）
      const remixed = tryPcMergeFeatures(pc, other);
      if (remixed && unionResultTouchesAllInputs(remixed, leaves)) {
        return remixed;
      }
      stats.usedConcat = true;
      stats.concatParts++;
      return concatMultiPolygon(pc, other);
    }

    // missing ≡ 全体（判定不能）→ 二分へ
    stats.usedRecursive = true;
  }

  // PC throw/null、または coverage 不能 → 空間二分
  stats.usedRecursive = true;
  const sorted = sortSpatially(leaves) as Feature<Polygon>[];
  const mid = Math.floor(sorted.length / 2);
  const leftLeaves = sorted.slice(0, mid);
  const rightLeaves = sorted.slice(mid);

  const leftStats = emptyStats();
  const rightStats = emptyStats();
  const left = unionGroupRobust(leftLeaves, leftStats);
  const right = unionGroupRobust(rightLeaves, rightStats);
  mergeStats(stats, leftStats);
  mergeStats(stats, rightStats);

  if (!left) return right;
  if (!right) return left;

  const merged = tryPcMergeFeatures(left, right);
  if (merged && unionResultTouchesAllInputs(merged, leaves)) {
    return merged;
  }

  // 再結合が部分欠落または失敗 → まず missing rescue、だめなら concat
  if (merged) {
    const missing = uncoveredInputs(merged, leaves);
    if (missing.length > 0 && missing.length < leaves.length) {
      stats.pcRecoveries++;
      const rescued = unionGroupRobust(missing, stats);
      const other = rescued ?? mergeComponentResults(missing);
      if (other) {
        const remixed = tryPcMergeFeatures(merged, other);
        if (remixed && unionResultTouchesAllInputs(remixed, leaves)) {
          return remixed;
        }
        stats.usedConcat = true;
        stats.concatParts++;
        return concatMultiPolygon(merged, other);
      }
    }
  }

  stats.usedConcat = true;
  stats.concatParts++;
  stats.pcRecoveries++;
  return concatMultiPolygon(left, right);
}

function connectedComponents(
  features: Feature<Polygon>[]
): Feature<Polygon>[][] {
  const n = features.length;
  if (n === 0) return [];
  if (n === 1) return [[features[0]!]];

  const boxes = features.map((f) => featureBbox(f));
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    let p = i;
    while (parent[p] !== p) p = parent[p]!;
    let x = i;
    while (parent[x] !== x) {
      const next = parent[x]!;
      parent[x] = p;
      x = next;
    }
    return p;
  };
  const unite = (a: number, b: number) => {
    const pa = find(a);
    const pb = find(b);
    if (pa !== pb) parent[pa] = pb;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (bboxesOverlap(boxes[i]!, boxes[j]!)) unite(i, j);
    }
  }

  const groups = new Map<number, Feature<Polygon>[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(features[i]!);
    groups.set(root, list);
  }
  return [...groups.values()];
}

function mergeComponentResults(parts: PolyFeature[]): PolyFeature | null {
  let merged: PolyFeature | null = null;
  for (const part of parts) {
    merged = merged ? concatMultiPolygon(merged, part) : part;
  }
  return merged;
}

export type UnionStrategy = "polygon-clipping" | "pc-recursive";

export type UnionAllResult = {
  feature: Feature<Polygon | MultiPolygon> | null;
  strategy: UnionStrategy;
  usedConcat: boolean;
  pcRecoveries: number;
  concatParts: number;
};

/**
 * ポリゴン配列を union する。連結成分単位で polygon-clipping、
 * 失敗・部分欠落時は再帰分割と MultiPolygon 連結（Turf 不使用）。
 *
 * `skipped` は互換のため残すが、本経路では増やさない。
 */
export function unionAllPolygons(
  features: Feature<Polygon>[],
  skipped: { count: number }
): Feature<Polygon | MultiPolygon> | null {
  return unionAllPolygonsDetailed(features, skipped).feature;
}

export function unionAllPolygonsDetailed(
  features: Feature<Polygon>[],
  _skipped: { count: number }
): UnionAllResult {
  if (features.length === 0) {
    return {
      feature: null,
      strategy: "polygon-clipping",
      usedConcat: false,
      pcRecoveries: 0,
      concatParts: 0,
    };
  }
  if (features.length === 1) {
    return {
      feature: features[0] ?? null,
      strategy: "polygon-clipping",
      usedConcat: false,
      pcRecoveries: 0,
      concatParts: 0,
    };
  }

  const components = connectedComponents(features);
  const pcParts: PolyFeature[] = [];
  const stats = emptyStats();

  for (const group of components) {
    const part = unionGroupRobust(group, stats);
    if (part) pcParts.push(part);
  }

  // 成分間はもともと非接続なので concat（これは「回復」ではなく構造）
  const feature =
    pcParts.length <= 1 ? (pcParts[0] ?? null) : mergeComponentResults(pcParts);

  const strategy: UnionStrategy = stats.usedRecursive
    ? "pc-recursive"
    : "polygon-clipping";

  return {
    feature,
    strategy,
    usedConcat: stats.usedConcat,
    pcRecoveries: stats.pcRecoveries,
    concatParts: stats.concatParts,
  };
}
