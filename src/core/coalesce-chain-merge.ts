import { lineString } from "@turf/helpers";
import type { Position } from "geojson";
import { bearingDegrees, edgeLengthMeters } from "./edge-gap-geometry.js";
import {
  COALESCE_EXACT_TIP_M,
  COALESCE_MIN_OPPOSITE_BEARING_DEG,
  type CoalesceEdgesDiagnostics,
} from "./coalesce-edges-config.js";
import { haversineMeters } from "./geodesy.js";
import type { LineFeature } from "./types.js";
/** tip から縁の内側へ向かう方位（度） */
function tipInwardBearing(edge: LineFeature, end: "a" | "b"): number | null {
  const coords = edge.geometry.coordinates;
  if (coords.length < 2) return null;
  if (end === "a") {
    const a = coords[0]!;
    const next = coords[1]!;
    return bearingDegrees(a[0]!, a[1]!, next[0]!, next[1]!);
  }
  const b = coords[coords.length - 1]!;
  const prev = coords[coords.length - 2]!;
  return bearingDegrees(b[0]!, b[1]!, prev[0]!, prev[1]!);
}

/** 2方位のなす角を 0..180 に畳む（0=同方向、180=反対＝継続向き） */
function oppositeBearingDiffDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

function tipsFormContinuation(
  edgeA: LineFeature,
  endA: "a" | "b",
  edgeB: LineFeature,
  endB: "a" | "b",
  minOppositeDeg: number
): boolean {
  const ba = tipInwardBearing(edgeA, endA);
  const bb = tipInwardBearing(edgeB, endB);
  if (ba == null || bb == null) return false;
  return oppositeBearingDiffDeg(ba, bb) >= minOppositeDeg;
}

type TipRef = { edgeIndex: number; end: "a" | "b"; coord: Position };

function tipCoord(edge: LineFeature, end: "a" | "b"): Position {
  const coords = edge.geometry.coordinates;
  return end === "a" ? coords[0]! : coords[coords.length - 1]!;
}

function clusterTips(tips: TipRef[], epsilonM: number): number[] {
  const parent = tips.map((_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    let cur = x;
    while (parent[cur] !== r) {
      const next = parent[cur]!;
      parent[cur] = r;
      cur = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < tips.length; i++) {
    for (let j = i + 1; j < tips.length; j++) {
      const a = tips[i]!.coord;
      const b = tips[j]!.coord;
      if (haversineMeters(a[0]!, a[1]!, b[0]!, b[1]!) <= epsilonM) {
        union(i, j);
      }
    }
  }
  return tips.map((_, i) => find(i));
}

type ChainLink = {
  otherEdge: number;
  myEnd: "a" | "b";
  otherEnd: "a" | "b";
};

/**
 * 縁を端点次数2の接合で連結する。向きを揃えて座標を結合し、
 * 属性は最長辺から継承する。
 */
export function mergeDegree2Chains(
  edges: LineFeature[],
  epsilonM: number,
  minMeaningfulEdgeM: number,
  diagnostics: CoalesceEdgesDiagnostics
): LineFeature[] {
  if (edges.length <= 1) return [...edges];

  const meaningful: { edge: LineFeature; index: number; len: number }[] = [];
  const passthrough: LineFeature[] = [];

  for (const [index, edge] of edges.entries()) {
    const coords = edge.geometry.coordinates;
    const len = edgeLengthMeters(coords);
    if (coords.length < 2 || len < minMeaningfulEdgeM) {
      passthrough.push(edge);
      continue;
    }
    meaningful.push({ edge, index, len });
  }

  if (meaningful.length <= 1) return [...edges];

  // Remap to dense indices 0..n-1 for graph work
  const tips: TipRef[] = [];
  for (let i = 0; i < meaningful.length; i++) {
    const edge = meaningful[i]!.edge;
    tips.push({
      edgeIndex: i,
      end: "a",
      coord: tipCoord(edge, "a"),
    });
    tips.push({
      edgeIndex: i,
      end: "b",
      coord: tipCoord(edge, "b"),
    });
  }

  const clusterOf = clusterTips(tips, epsilonM);
  const clusters = new Map<number, TipRef[]>();
  for (let t = 0; t < tips.length; t++) {
    const root = clusterOf[t]!;
    const list = clusters.get(root) ?? [];
    list.push(tips[t]!);
    clusters.set(root, list);
  }

  const adjacency = new Map<number, ChainLink[]>();
  const addLink = (from: number, link: ChainLink) => {
    const list = adjacency.get(from) ?? [];
    list.push(link);
    adjacency.set(from, list);
  };

  for (const members of clusters.values()) {
    const edgeIds = members.map((m) => m.edgeIndex);
    const uniqueEdges = new Set(edgeIds);
    if (uniqueEdges.size < members.length) {
      // 同一縁の両端が同一クラスタ（ほぼ閉じた環）→ 連結しない
      diagnostics.skippedSameEdgeClusters++;
      continue;
    }
    if (members.length >= 3) {
      diagnostics.skippedDegreeGe3Nodes++;
      continue;
    }
    if (members.length !== 2) continue;

    const [t0, t1] = members;
    if (t0!.edgeIndex === t1!.edgeIndex) continue;

    const tipGapM = haversineMeters(
      t0!.coord[0]!,
      t0!.coord[1]!,
      t1!.coord[0]!,
      t1!.coord[1]!
    );
    // 近接のみ（狭い対向縁の両 tip が同一クラスタになるケース）で方位を要求。
    // 座標一致の接合は U/L コーナー含め常に鎖へ。
    if (tipGapM > COALESCE_EXACT_TIP_M) {
      const edge0 = meaningful[t0!.edgeIndex]!.edge;
      const edge1 = meaningful[t1!.edgeIndex]!.edge;
      if (
        !tipsFormContinuation(
          edge0,
          t0!.end,
          edge1,
          t1!.end,
          COALESCE_MIN_OPPOSITE_BEARING_DEG
        )
      ) {
        diagnostics.skippedNonContinuation++;
        continue;
      }
    }

    diagnostics.degree2NodesUsed++;
    addLink(t0!.edgeIndex, {
      otherEdge: t1!.edgeIndex,
      myEnd: t0!.end,
      otherEnd: t1!.end,
    });
    addLink(t1!.edgeIndex, {
      otherEdge: t0!.edgeIndex,
      myEnd: t1!.end,
      otherEnd: t0!.end,
    });
  }

  const visited = new Set<number>();
  const merged: LineFeature[] = [];

  const degree = (i: number) => adjacency.get(i)?.length ?? 0;

  const walkChain = (start: number): number[] => {
    const path: number[] = [start];
    visited.add(start);
    let prev = -1;
    let cur = start;
    while (true) {
      const links = adjacency.get(cur) ?? [];
      const nextLink = links.find((l) => l.otherEdge !== prev);
      if (!nextLink) break;
      const next = nextLink.otherEdge;
      if (visited.has(next)) break;
      path.push(next);
      visited.add(next);
      prev = cur;
      cur = next;
    }
    return path;
  };

  // Path ends first (degree 1), then any leftover degree-2 cycles
  for (let i = 0; i < meaningful.length; i++) {
    if (visited.has(i)) continue;
    if (degree(i) === 1) {
      const path = walkChain(i);
      merged.push(buildMergedEdge(path, meaningful, diagnostics));
    }
  }
  for (let i = 0; i < meaningful.length; i++) {
    if (visited.has(i)) continue;
    if (degree(i) === 0) {
      visited.add(i);
      merged.push(meaningful[i]!.edge);
      continue;
    }
    // degree 2 cycle
    const path = walkChain(i);
    merged.push(buildMergedEdge(path, meaningful, diagnostics));
  }

  return [...merged, ...passthrough];
}

function buildMergedEdge(
  path: number[],
  meaningful: { edge: LineFeature; index: number; len: number }[],
  diagnostics: CoalesceEdgesDiagnostics
): LineFeature {
  if (path.length === 1) {
    return meaningful[path[0]!]!.edge;
  }

  diagnostics.chainsMerged++;
  diagnostics.edgesAbsorbedInChains += path.length;

  let longestIdx = path[0]!;
  let longestLen = meaningful[longestIdx]!.len;
  const vtCodes = new Set<unknown>();
  for (const pi of path) {
    const m = meaningful[pi]!;
    if (m.len > longestLen) {
      longestLen = m.len;
      longestIdx = pi;
    }
    vtCodes.add(m.edge.properties?.vt_code);
  }
  if (vtCodes.size > 1) diagnostics.attributeConflicts++;

  const first = path[0]!;
  const second = path[1]!;
  let coords = meaningful[first]!.edge.geometry.coordinates.slice();
  const secondEdge = meaningful[second]!.edge;
  const firstA = coords[0]!;
  const firstB = coords[coords.length - 1]!;
  const secA = tipCoord(secondEdge, "a");
  const secB = tipCoord(secondEdge, "b");
  const dBa = haversineMeters(firstB[0]!, firstB[1]!, secA[0]!, secA[1]!);
  const dBb = haversineMeters(firstB[0]!, firstB[1]!, secB[0]!, secB[1]!);
  const dAa = haversineMeters(firstA[0]!, firstA[1]!, secA[0]!, secA[1]!);
  const dAb = haversineMeters(firstA[0]!, firstA[1]!, secB[0]!, secB[1]!);
  if (Math.min(dAa, dAb) < Math.min(dBa, dBb)) {
    coords = coords.reverse();
  }

  for (let p = 1; p < path.length; p++) {
    const nextCoords = meaningful[path[p]!]!.edge.geometry.coordinates;
    const tip = coords[coords.length - 1]!;
    const nA = nextCoords[0]!;
    const nB = nextCoords[nextCoords.length - 1]!;
    const dA = haversineMeters(tip[0]!, tip[1]!, nA[0]!, nA[1]!);
    const dB = haversineMeters(tip[0]!, tip[1]!, nB[0]!, nB[1]!);
    const oriented = dA <= dB ? nextCoords : [...nextCoords].reverse();
    coords = coords.concat(oriented.slice(1));
  }

  const baseProps = {
    ...(meaningful[longestIdx]!.edge.properties ?? {}),
  };
  return lineString(coords, {
    ...baseProps,
    _coalesced: true,
    _coalesceEdgeCount: path.length,
  });
}
