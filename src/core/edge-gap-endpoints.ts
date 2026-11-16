import type { Position } from "geojson";
import { haversineMeters } from "./geodesy.js";
import {
  GAP_BODY_OVERLAP_EPSILON_M,
  GAP_CONNECTED_EPSILON_M,
  GAP_MIN_MEANINGFUL_EDGE_M,
  GAP_SELF_CLOSE_MIN_PATH_RATIO,
  type EdgeGapDiagnostics,
  type EdgeGapKind,
  type EdgeGapOptions,
} from "./edge-gap-config.js";
import { bearingDegrees, edgeLengthMeters } from "./edge-gap-geometry.js";
import {
  metersToDegPad,
  minDistToLineLocal,
} from "./edge-gap-classification.js";
import { BBoxIndex, bboxesOverlap, lineFeatureBBox } from "./spatial-index.js";
import type { LineFeature } from "./types.js";
export type Endpoint = {
  edgeIndex: number;
  end: "a" | "b";
  coord: Position;
  /** 端から内側へ向かう方位（度, -180..180） */
  inwardBearing: number;
};

export type RawPair = {
  a: Endpoint;
  b: Endpoint;
  gapM: number;
};

/** 候補探索・競合判定に使う最大距離（m） */
export function maxBridgeScanM(options: EdgeGapOptions): number {
  return Math.max(options.maxBridgeM, options.maxBridgeMidRoadM);
}

/** kind 別の橋渡し上限（m）。overlap 等は呼び出し側で除外 */
export function maxBridgeForKind(
  kind: EdgeGapKind,
  options: EdgeGapOptions
): number {
  return kind === "mid-road" ? options.maxBridgeMidRoadM : options.maxBridgeM;
}

export function emptyEdgeGapDiagnostics(): EdgeGapDiagnostics {
  return {
    danglingEndpoints: 0,
    candidatePairs: 0,
    midRoad: 0,
    deadEnd: 0,
    ambiguous: 0,
    selfClose: 0,
    overlap: 0,
    topology: 0,
    closedRingsSkipped: 0,
    bridged: 0,
    skippedEndpointReuse: 0,
    skippedWorkBoundary: 0,
  };
}

/** 点から軸平行 bbox 各辺までの最短距離（m） */
function isMeaningfulEdge(
  coords: Position[],
  minLengthM = GAP_MIN_MEANINGFUL_EDGE_M
): boolean {
  return coords.length >= 2 && edgeLengthMeters(coords) >= minLengthM;
}

export function endpointKey(e: Endpoint): string {
  return `${e.edgeIndex}:${e.end}`;
}

export function pairKey(a: Endpoint, b: Endpoint): string {
  const k1 = endpointKey(a);
  const k2 = endpointKey(b);
  return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
}

function isClosedRing(coords: Position[], connectedEpsilonM: number): boolean {
  if (coords.length < 3) return false;
  const a = coords[0]!;
  const b = coords[coords.length - 1]!;
  const chord = haversineMeters(a[0], a[1], b[0], b[1]);
  if (chord > connectedEpsilonM) return false;
  // 路長が ε 程度の短断片は「始点≈終点」でも環ではない（0.7m スタブ等）
  const pathLen = edgeLengthMeters(coords);
  return pathLen >= connectedEpsilonM * GAP_SELF_CLOSE_MIN_PATH_RATIO;
}

/**
 * 端点を収集する。既に閉じた環（始点≈終点）はダングリング端を持たないため除外。
 */
export function collectEndpoints(
  edges: LineFeature[],
  connectedEpsilonM: number,
  diagnostics: EdgeGapDiagnostics
): Endpoint[] {
  const out: Endpoint[] = [];
  for (const [edgeIndex, edge] of edges.entries()) {
    const coords = edge.geometry.coordinates;
    if (coords.length < 2) continue;
    // 微短スタブは接合判定の錨にしない（本線端の誤 non-dangling 化を防ぐ）
    if (!isMeaningfulEdge(coords)) continue;
    if (isClosedRing(coords, connectedEpsilonM)) {
      diagnostics.closedRingsSkipped++;
      continue;
    }
    const a = coords[0];
    const b = coords[coords.length - 1];
    const aNext = coords[Math.min(1, coords.length - 1)];
    const bPrev = coords[Math.max(0, coords.length - 2)];
    out.push({
      edgeIndex,
      end: "a",
      coord: a,
      inwardBearing: bearingDegrees(a[0], a[1], aNext[0], aNext[1]),
    });
    out.push({
      edgeIndex,
      end: "b",
      coord: b,
      inwardBearing: bearingDegrees(b[0], b[1], bPrev[0], bPrev[1]),
    });
  }
  return out;
}

export interface EdgeEndpointAnalysis {
  endpoints: Endpoint[];
  freeEndpoints: Endpoint[];
  coverageByKey: Map<string, { edgeIndex: number; distM: number } | null>;
  joinedByKey: Map<string, { edgeIndex: number; distM: number } | null>;
  edgeIndex: BBoxIndex<LineFeature>;
  edgeIndexByFeature: WeakMap<LineFeature, number>;
}

/** Build the shared endpoint topology used by bridge generation and spill checks. */
export function analyzeEdgeEndpoints(
  edges: LineFeature[],
  connectedEpsilonM: number,
  diagnostics: EdgeGapDiagnostics
): EdgeEndpointAnalysis {
  const edgeIndexByFeature = new WeakMap<LineFeature, number>();
  for (const [edgeIndex, edge] of edges.entries()) {
    edgeIndexByFeature.set(edge, edgeIndex);
  }
  const edgeIndex = BBoxIndex.fromLineFeatures(edges);
  const endpoints = collectEndpoints(edges, connectedEpsilonM, diagnostics);
  const coverageByKey = new Map<
    string,
    { edgeIndex: number; distM: number } | null
  >();
  const joinedByKey = new Map<
    string,
    { edgeIndex: number; distM: number } | null
  >();

  for (const endpoint of endpoints) {
    const key = endpointKey(endpoint);
    joinedByKey.set(
      key,
      endpointJoinedToOtherEndpoint(
        endpoint,
        endpoints,
        edges,
        connectedEpsilonM
      )
    );
  }
  for (const endpoint of endpoints) {
    const key = endpointKey(endpoint);
    coverageByKey.set(
      key,
      endpointCoveredByOtherEdge(
        endpoint,
        edges,
        endpoints,
        connectedEpsilonM,
        GAP_BODY_OVERLAP_EPSILON_M,
        edgeIndex,
        edgeIndexByFeature
      )
    );
  }

  const freeEndpoints = endpoints.filter((endpoint) => {
    const key = endpointKey(endpoint);
    return !coverageByKey.get(key) && !joinedByKey.get(key);
  });

  return {
    endpoints,
    freeEndpoints,
    coverageByKey,
    joinedByKey,
    edgeIndex,
    edgeIndexByFeature,
  };
}

/**
 * 同一縁の始点↔終点ギャップ（ほぼ閉じた輪の切れ目）。
 * 両端に、self 弦長以下の他縁自由端があるときだけ候補にしない
 * （近い対岸への mid-road を端点再利用で落とさない。遠い対岸は競合とみなさない）。
 */
export function collectSelfClosePairs(
  edges: LineFeature[],
  endpointsByEdge: Map<number, { a: Endpoint; b: Endpoint }>,
  freeEndpoints: Endpoint[],
  options: EdgeGapOptions
): RawPair[] {
  const pairs: RawPair[] = [];
  for (const [edgeIndex, ends] of endpointsByEdge) {
    const coords = edges[edgeIndex]?.geometry.coordinates;
    if (!coords || coords.length < 3) continue;
    const gapM = haversineMeters(
      ends.a.coord[0],
      ends.a.coord[1],
      ends.b.coord[0],
      ends.b.coord[1]
    );
    if (gapM <= options.connectedEpsilonM) continue;
    if (gapM > options.maxBridgeM) continue;
    // 路長≈弦長の短い開線は輪ではない（例: 他縁に重なる 14m 断片）
    const pathLen = edgeLengthMeters(coords);
    if (pathLen < gapM * GAP_SELF_CLOSE_MIN_PATH_RATIO) continue;
    // 同距離帯の対岸 tip があるときだけ self-close を譲る（ε でほぼ同距離を含む）
    const competeWithinM = gapM + options.connectedEpsilonM;
    if (
      hasCrossEdgeFreePartner(ends.a, freeEndpoints, options, competeWithinM) &&
      hasCrossEdgeFreePartner(ends.b, freeEndpoints, options, competeWithinM)
    ) {
      continue;
    }
    pairs.push({ a: ends.a, b: ends.b, gapM });
  }
  return pairs;
}

/** 他縁の自由端が ε〜maxDistM 内にあるか（self-close と競合しうる対岸 tip） */
function hasCrossEdgeFreePartner(
  ep: Endpoint,
  freeEndpoints: Endpoint[],
  options: EdgeGapOptions,
  maxDistM: number
): boolean {
  const limit = Math.min(maxDistM, maxBridgeScanM(options));
  for (const other of freeEndpoints) {
    if (other.edgeIndex === ep.edgeIndex) continue;
    const distM = haversineMeters(
      ep.coord[0],
      ep.coord[1],
      other.coord[0],
      other.coord[1]
    );
    if (distM <= options.connectedEpsilonM) continue;
    if (distM <= limit) return true;
  }
  return false;
}

export function nearestOtherEndpoint(
  ep: Endpoint,
  all: Endpoint[]
): { other: Endpoint; distM: number } | null {
  let best: Endpoint | null = null;
  let bestD = Infinity;
  for (const other of all) {
    if (other.edgeIndex === ep.edgeIndex) continue;
    const d = haversineMeters(
      ep.coord[0],
      ep.coord[1],
      other.coord[0],
      other.coord[1]
    );
    if (d < bestD) {
      bestD = d;
      best = other;
    }
  }
  if (!best) return null;
  return { other: best, distM: bestD };
}

/**
 * 端点が「自分以外の縁」の線上（端点に限らない）にあるか。
 * タイル境界の重複・ほぼ一致する縁で、見かけのギャップが既に埋まっている場合に使う。
 */
export function minDistanceToOtherEdgeBody(
  coord: Position,
  excludeEdgeIndexes: Iterable<number>,
  edges: LineFeature[],
  options?: { minMeaningfulEdgeM?: number },
  edgeIndex?: BBoxIndex<LineFeature>,
  edgeIndexByFeature?: WeakMap<LineFeature, number>
): { edgeIndex: number; distM: number } | null {
  const exclude = new Set(excludeEdgeIndexes);
  const minLen = options?.minMeaningfulEdgeM ?? GAP_MIN_MEANINGFUL_EDGE_M;
  let best: { edgeIndex: number; distM: number } | null = null;
  const pad = metersToDegPad(GAP_CONNECTED_EPSILON_M * 4, coord[1]!);
  const query: [number, number, number, number] = [
    coord[0]! - pad,
    coord[1]! - pad,
    coord[0]! + pad,
    coord[1]! + pad,
  ];
  if (edgeIndex && edgeIndexByFeature) {
    for (const edge of edgeIndex.search(query)) {
      const edgeIndexValue = edgeIndexByFeature.get(edge);
      if (edgeIndexValue == null || exclude.has(edgeIndexValue)) continue;
      if (!isMeaningfulEdge(edge.geometry.coordinates, minLen)) continue;
      const distM = minDistToLineLocal(coord[0]!, coord[1]!, edge).distM;
      if (!best || distM < best.distM) {
        best = { edgeIndex: edgeIndexValue, distM };
      }
    }
    return best;
  }
  for (const [edgeIndexValue, edge] of edges.entries()) {
    if (exclude.has(edgeIndexValue)) continue;
    if (!isMeaningfulEdge(edge.geometry.coordinates, minLen)) continue;
    if (!bboxesOverlap(query, lineFeatureBBox(edge))) continue;
    const distM = minDistToLineLocal(coord[0]!, coord[1]!, edge).distM;
    if (!best || distM < best.distM) {
      best = { edgeIndex: edgeIndexValue, distM };
    }
  }
  return best;
}

/**
 * 他縁の線体上にあるか（タイル重複の見かけ端）。
 * 端点共有している枝・継ぎ目縁は除外する（その縁の端への距離 0 を
 * 「線体 overlap」と誤認すると、本線ギャップの橋渡し候補から消える）。
 * overlap scrap は coalesce で除去済み前提。
 *
 * 線体判定は {@link GAP_BODY_OVERLAP_EPSILON_M}（狭い）。
 * 共有端の除外だけ tip 接合用の connectedEpsilonM を使う。
 */
export function endpointCoveredByOtherEdge(
  ep: Endpoint,
  edges: LineFeature[],
  allEndpoints: Endpoint[],
  connectedEpsilonM: number,
  bodyOverlapEpsilonM: number = GAP_BODY_OVERLAP_EPSILON_M,
  edgeIndex?: BBoxIndex<LineFeature>,
  edgeIndexByFeature?: WeakMap<LineFeature, number>
): { edgeIndex: number; distM: number } | null {
  const exclude = new Set<number>([ep.edgeIndex]);
  for (const other of allEndpoints) {
    if (other.edgeIndex === ep.edgeIndex) continue;
    const distM = haversineMeters(
      ep.coord[0],
      ep.coord[1],
      other.coord[0],
      other.coord[1]
    );
    if (distM > connectedEpsilonM) continue;
    // 真の継ぎ目・交差の端点共有
    exclude.add(other.edgeIndex);
  }
  const hit = minDistanceToOtherEdgeBody(
    ep.coord,
    exclude,
    edges,
    undefined,
    edgeIndex,
    edgeIndexByFeature
  );
  if (!hit || hit.distM > bodyOverlapEpsilonM) return null;
  return hit;
}

/**
 * 他縁の端点と一致するか（タイル境界等で 1 本が分割された継ぎ目）。
 * coalesce 後は端点一致を接合としてよい（線体重なり scrap は除去済み）。
 */
export function endpointJoinedToOtherEndpoint(
  ep: Endpoint,
  all: Endpoint[],
  _edges: LineFeature[],
  epsilonM: number
): { edgeIndex: number; distM: number } | null {
  let best: { edgeIndex: number; distM: number } | null = null;
  for (const other of all) {
    if (other.edgeIndex === ep.edgeIndex) continue;
    const distM = haversineMeters(
      ep.coord[0],
      ep.coord[1],
      other.coord[0],
      other.coord[1]
    );
    if (distM > epsilonM) continue;
    if (!best || distM < best.distM) {
      best = { edgeIndex: other.edgeIndex, distM };
    }
  }
  return best;
}

export function shouldBridgeKind(
  kind: EdgeGapKind,
  bridgeMidRoad: boolean
): boolean {
  if (kind === "mid-road") return bridgeMidRoad;
  // overlap は別経路で kind=overlap になり接続しない。
  // dead-end は真の線端同士（タイル境界の見かけ端ではない）なら口を閉じる。
  return (
    kind === "self-close" ||
    kind === "topology" ||
    kind === "dead-end"
  );
}
