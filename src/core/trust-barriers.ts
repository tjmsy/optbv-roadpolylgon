/**
 * CL 信頼境（safe ↔ provisional/excluded）に道路横断バリアを置き、
 * buffer/difference でセルを分割する。
 *
 * パイプライン既定ではオフ（`includeTrustBarriers: true` で有効）。
 *
 * @see docs/research/07-centerline-trust-barriers.md
 * @see docs/adr/002-centerline-trust-barriers.md
 */
import type { Position } from "geojson";
import type { LineFeature } from "./types.js";
import {
  TRUST_BARRIER_DEDUP_M,
  TRUST_BARRIER_ENDPOINT_MATCH_M,
  TRUST_BARRIER_MAX_HALF_WIDTH_M,
  type TrustBarrierDiagnostics,
  type TrustBarrierResult,
} from "./trust-barrier-config.js";
export * from "./trust-barrier-config.js";
import { BBoxIndex, PointGridIndex } from "./spatial-index.js";
import {
  barrierLineAtPoint,
  collectEnds,
  coordDistMeters,
  minDistToLineBodyLocal,
  type SegEnd,
} from "./trust-barrier-geometry.js";
export { barrierLineAtPoint } from "./trust-barrier-geometry.js";
import {
  localVectorMeters,
  metersToDegPad,
  offsetLocalMeters,
} from "./geodesy.js";
import { lineString } from "@turf/helpers";

type Boundary = { coord: Position; tangent: Position };

/**
 * safe と provisional/excluded の境に横断バリアを生成する。
 *
 * - 端点同士が近接（同一 CL のコリドー分割境）
 * - safe 端点が non-safe 線体に近接（T 字で幹線が連続している場合）
 */
export function buildTrustBarriers(
  safe: LineFeature[],
  provisional: LineFeature[],
  excluded: LineFeature[],
  edges: LineFeature[],
  options?: {
    endpointMatchM?: number;
    maxHalfWidthM?: number;
    dedupM?: number;
  }
): TrustBarrierResult {
  const endpointMatchM =
    options?.endpointMatchM ?? TRUST_BARRIER_ENDPOINT_MATCH_M;
  const maxHalfWidthM =
    options?.maxHalfWidthM ?? TRUST_BARRIER_MAX_HALF_WIDTH_M;
  const dedupM = options?.dedupM ?? TRUST_BARRIER_DEDUP_M;

  const diagnostics: TrustBarrierDiagnostics = {
    candidateBoundaries: 0,
    barriersBuilt: 0,
    skippedNoTangent: 0,
    skippedTooShort: 0,
  };

  const safeEnds = collectEnds(safe, "safe");
  const nonSafe = [...provisional, ...excluded];
  const nonSafeEnds = [
    ...collectEnds(provisional, "non-safe"),
    ...collectEnds(excluded, "non-safe"),
  ];

  const lat0 = safeEnds[0]?.coord[1] ?? nonSafeEnds[0]?.coord[1] ?? 35;
  // 対角方向の端点マッチで lon/lat ユークリッドがハバーサインより大きくならないよう余裕を持たせる
  const matchDeg = metersToDegPad(endpointMatchM, lat0) * 1.5;
  const nonSafeEndIndex = new PointGridIndex<SegEnd>(Math.max(matchDeg, 1e-6));
  for (const n of nonSafeEnds) {
    nonSafeEndIndex.insert(n.coord[0]!, n.coord[1]!, n);
  }
  const nonSafeLineIndex = BBoxIndex.fromLineFeatures(nonSafe);
  const edgeIndex = BBoxIndex.fromLineFeatures(edges);

  const boundaries: Boundary[] = [];

  const pushBoundary = (coord: Position, tangent: Position | null) => {
    diagnostics.candidateBoundaries++;
    if (!tangent) {
      diagnostics.skippedNoTangent++;
      return;
    }
    boundaries.push({ coord, tangent });
  };

  // 1) safe 端 ↔ non-safe 端
  for (const s of safeEnds) {
    const nearby = nonSafeEndIndex.searchRadius(
      s.coord[0]!,
      s.coord[1]!,
      matchDeg
    );
    for (const n of nearby) {
      if (coordDistMeters(s.coord, n.coord) > endpointMatchM) continue;
      pushBoundary(
        [(s.coord[0] + n.coord[0]) / 2, (s.coord[1] + n.coord[1]) / 2],
        s.tangent ?? n.tangent
      );
    }
  }

  // 2) safe 端 ↔ non-safe 線体（T 字・幹線連続）
  // 端点そのものは幹線中央に乗りやすく、接線垂直バリアが幹線並行になる。
  // safe 側へ少し下げた位置で側道を横断する。
  const insetM = 2;
  for (const s of safeEnds) {
    const pad = metersToDegPad(endpointMatchM, s.coord[1]!);
    const query: [number, number, number, number] = [
      s.coord[0]! - pad,
      s.coord[1]! - pad,
      s.coord[0]! + pad,
      s.coord[1]! + pad,
    ];
    const nearbyLines = nonSafeLineIndex.search(query);
    let bestDist = Infinity;
    for (const line of nearbyLines) {
      const d = minDistToLineBodyLocal(s.coord, line);
      if (d < bestDist) bestDist = d;
    }
    if (bestDist > endpointMatchM) continue;
    if (!s.tangent) {
      diagnostics.candidateBoundaries++;
      diagnostics.skippedNoTangent++;
      continue;
    }
    const [tx, ty] = localVectorMeters(s.coord, [
      s.coord[0] + s.tangent[0],
      s.coord[1] + s.tangent[1],
    ]);
    const tLen = Math.hypot(tx, ty);
    if (tLen < 1e-12) {
      diagnostics.candidateBoundaries++;
      diagnostics.skippedNoTangent++;
      continue;
    }
    // 端から線内向きへ inset（atStart なら tangent 方向、atEnd なら逆）
    const inx = s.atStart ? tx / tLen : -tx / tLen;
    const iny = s.atStart ? ty / tLen : -ty / tLen;
    const inset = offsetLocalMeters(s.coord, inx * insetM, iny * insetM);
    pushBoundary(inset, s.tangent);
  }

  const deduped: Boundary[] = [];
  for (const b of boundaries) {
    if (deduped.some((d) => coordDistMeters(d.coord, b.coord) < dedupM)) {
      continue;
    }
    deduped.push(b);
  }

  const barriers: LineFeature[] = [];
  for (const b of deduped) {
    const coords = barrierLineAtPoint(
      b.coord,
      b.tangent,
      edges,
      maxHalfWidthM,
      edgeIndex
    );
    if (!coords) {
      diagnostics.skippedTooShort++;
      continue;
    }
    barriers.push(
      lineString(coords, {
        _trustBarrier: true,
        kind: "trust-boundary",
      })
    );
    diagnostics.barriersBuilt++;
  }

  return { barriers, diagnostics };
}
