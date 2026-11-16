import { lineString } from "@turf/helpers";
import type { Feature, LineString } from "geojson";
import type { LineFeature } from "./types.js";
import { haversineMeters } from "./geodesy.js";
import { METERS_PER_DEGREE_LONGITUDE_EQUATOR } from "./geodesy.js";
import {
  blocksBridgeOnWorkBoundary,
  isOneSidedWorkBoundaryBridge,
} from "./edge-gap-boundary.js";
import { nearestBridgePartner } from "./edge-gap-pairing.js";
export { minDistanceToBboxBoundaryM } from "./edge-gap-boundary.js";
import {
  DEFAULT_EDGE_GAP_OPTIONS,
  GAP_STUB_HUB_MAX_M,
  type CloseEdgeGapsResult,
  type EdgeGapKind,
  type EdgeGapOptions,
} from "./edge-gap-config.js";
export * from "./edge-gap-config.js";
import {
  centerlineContext,
  classifyEdgeGap,
  type PairClassification,
} from "./edge-gap-classification.js";
export { classifyEdgeGap } from "./edge-gap-classification.js";
import {
  acuteAngleDifferenceDeg,
  bearingDegrees,
  edgeGapMid,
  edgeGapStableId,
  edgeLengthMeters,
} from "./edge-gap-geometry.js";

export { haversineMeters } from "./geodesy.js";
export {
  acuteAngleDifferenceDeg,
  bearingDegrees,
  edgeGapMid,
  edgeGapStableId,
  edgeLengthMeters,
  GAP_GID_COORD_DECIMALS,
  roundGapCoord,
} from "./edge-gap-geometry.js";
import { BBoxIndex, PointGridIndex } from "./spatial-index.js";

import {
  collectSelfClosePairs,
  analyzeEdgeEndpoints,
  emptyEdgeGapDiagnostics,
  endpointKey,
  maxBridgeForKind,
  maxBridgeScanM,
  nearestOtherEndpoint,
  pairKey,
  shouldBridgeKind,
  type Endpoint,
  type RawPair,
} from "./edge-gap-endpoints.js";
export {
  emptyEdgeGapDiagnostics,
  minDistanceToOtherEdgeBody,
} from "./edge-gap-endpoints.js";
export {
  listDanglingOpeningTips,
  type DanglingOpeningTip,
} from "./edge-gap-dangling.js";
/**
 * 縁端点ギャップを検知・分類し、必要なものを橋渡しする。
 *
 * 前提: 入力 RdEdg は `coalesceRoadEdges` 済みが望ましい（パイプラインは必須）。
 * 接続しない: 閉じた環・他縁線体上の端点（タイル重複）・他縁端点と接合した端。
 * 接続する: mid-road / self-close / topology / dead-end（真のダングリング線端）。
 * 微短スタブ（GAP_MIN_MEANINGFUL_EDGE_M 未満）は端点収集から除外する。
 * 短い対が直近相手を先に消費した場合は、未使用端どうしで再探索する。
 * 近い端が候補に残っていない相手縁の遠端への橋は短絡とみなさない。
 */
export function closeEdgeGaps(
  edges: LineFeature[],
  centerlines: LineFeature[],
  partialOptions?: Partial<EdgeGapOptions>
): CloseEdgeGapsResult {
  const options: EdgeGapOptions = {
    ...DEFAULT_EDGE_GAP_OPTIONS,
    ...partialOptions,
  };
  const diagnostics = emptyEdgeGapDiagnostics();
  const endpointAnalysis = analyzeEdgeEndpoints(
    edges,
    options.connectedEpsilonM,
    diagnostics
  );
  const { endpoints, freeEndpoints, coverageByKey } = endpointAnalysis;

  const endpointsByEdge = new Map<number, { a: Endpoint; b: Endpoint }>();
  for (const ep of endpoints) {
    const cur = endpointsByEdge.get(ep.edgeIndex) ?? {
      a: ep,
      b: ep,
    };
    if (ep.end === "a") cur.a = ep;
    else cur.b = ep;
    endpointsByEdge.set(ep.edgeIndex, cur);
  }

  for (const ep of freeEndpoints) {
    const nearest = nearestOtherEndpoint(ep, freeEndpoints);
    const self = endpointsByEdge.get(ep.edgeIndex);
    const selfOpp = self && ep.end === "a" ? self.b : self?.a;
    const selfDist = selfOpp
      ? haversineMeters(
          ep.coord[0],
          ep.coord[1],
          selfOpp.coord[0],
          selfOpp.coord[1]
        )
      : Infinity;
    const nearestDist = nearest?.distM ?? Infinity;
    if (Math.min(nearestDist, selfDist) > options.connectedEpsilonM) {
      diagnostics.danglingEndpoints++;
    }
  }

  const selfClosePairs = collectSelfClosePairs(
    edges,
    endpointsByEdge,
    freeEndpoints,
    options
  );
  const selfCloseTipKeys = new Set<string>();
  for (const selfPair of selfClosePairs) {
    selfCloseTipKeys.add(endpointKey(selfPair.a));
    selfCloseTipKeys.add(endpointKey(selfPair.b));
  }

  const scanM = maxBridgeScanM(options);
  const cellSizeDeg = Math.max(
    scanM / METERS_PER_DEGREE_LONGITUDE_EQUATOR,
    1e-5
  );
  const clIndex = BBoxIndex.fromLineFeatures(centerlines);
  const pairClassificationCache = new Map<string, PairClassification>();
  const classifyPair = (a: Endpoint, b: Endpoint): PairClassification => {
    const key = pairKey(a, b);
    const cached = pairClassificationCache.get(key);
    if (cached) return cached;

    const bridgeBearing = bearingDegrees(
      a.coord[0],
      a.coord[1],
      b.coord[0],
      b.coord[1]
    );
    const midLon = (a.coord[0] + b.coord[0]) / 2;
    const midLat = (a.coord[1] + b.coord[1]) / 2;
    const cl = centerlineContext(midLon, midLat, clIndex);
    const classified = classifyEdgeGap(bridgeBearing, cl, options);
    const result: PairClassification = {
      cl,
      kind: classified.kind,
      angleToClDeg: classified.angleToClDeg,
    };
    pairClassificationCache.set(key, result);
    return result;
  };

  /**
   * 各自由端の最近傍だけを pairMap に載せる。短い対が先に端点を使うと
   * 長い本命が落ちるため、未使用端については複数ラウンドで再探索する。
   */
  const buildNearestPairs = (
    pool: Endpoint[],
    includeSelfClose: boolean
  ): RawPair[] => {
    const pairMap = new Map<string, RawPair>();
    if (includeSelfClose) {
      for (const selfPair of selfClosePairs) {
        pairMap.set(pairKey(selfPair.a, selfPair.b), selfPair);
      }
    }
    const endpointIndex = new PointGridIndex<Endpoint>(cellSizeDeg);
    for (const ep of pool) {
      endpointIndex.insert(ep.coord[0], ep.coord[1], ep);
    }
    for (const ep of pool) {
      const nearest = nearestBridgePartner(
        ep,
        pool,
        edges,
        classifyPair,
        options,
        endpointIndex,
        selfCloseTipKeys
      );
      if (!nearest) continue;
      if (nearest.distM <= options.connectedEpsilonM) continue;
      if (nearest.distM > scanM) continue;
      const key = pairKey(ep, nearest.other);
      const existing = pairMap.get(key);
      if (!existing || nearest.distM < existing.gapM) {
        pairMap.set(key, { a: ep, b: nearest.other, gapM: nearest.distM });
      }
    }
    return [...pairMap.values()].sort((x, y) => x.gapM - y.gapM);
  };

  const used = new Set<string>();
  const gapFeatures: Feature<LineString>[] = [];
  const bridges: LineFeature[] = [];
  const emittedGapKeys = new Set<string>();

  // 短い橋が直近相手を消費したあと、残った自由端どうしで本命ギャップを再探索する
  const maxRematchRounds = 8;
  for (let round = 0; round < maxRematchRounds; round++) {
    const pool =
      round === 0
        ? freeEndpoints
        : freeEndpoints.filter((ep) => !used.has(endpointKey(ep)));
    if (pool.length < 2) break;

    const pairs = buildNearestPairs(pool, round === 0);
    if (round === 0) diagnostics.candidatePairs = pairs.length;
    else diagnostics.candidatePairs += pairs.length;

    let bridgedThisRound = 0;
    for (const pair of pairs) {
      const ka = endpointKey(pair.a);
      const kb = endpointKey(pair.b);
      if (used.has(ka) || used.has(kb)) {
        diagnostics.skippedEndpointReuse++;
        continue;
      }

      const coverA = coverageByKey.get(ka) ?? null;
      const coverB = coverageByKey.get(kb) ?? null;
      // どちらかの端が他縁の線上にあれば、見かけのギャップは既に連続している
      const overlapHit = coverA ?? coverB;

      const sameEdge = pair.a.edgeIndex === pair.b.edgeIndex;
      const bridgeBearing = bearingDegrees(
        pair.a.coord[0],
        pair.a.coord[1],
        pair.b.coord[0],
        pair.b.coord[1]
      );
      const classified = classifyPair(pair.a, pair.b);
      const cl = classified.cl;

      let kind: EdgeGapKind;
      let angleToClDeg: number | null;
      if (overlapHit) {
        kind = "overlap";
        angleToClDeg = cl
          ? acuteAngleDifferenceDeg(bridgeBearing, cl.segmentBearing)
          : null;
        diagnostics.overlap++;
      } else if (sameEdge) {
        kind = "self-close";
        angleToClDeg = cl
          ? acuteAngleDifferenceDeg(bridgeBearing, cl.segmentBearing)
          : null;
        diagnostics.selfClose++;
      } else {
        kind = classified.kind;
        angleToClDeg = classified.angleToClDeg;
        if (kind === "mid-road") diagnostics.midRoad++;
        else if (kind === "dead-end") diagnostics.deadEnd++;
        else if (kind === "topology") diagnostics.topology++;
        else diagnostics.ambiguous++;
      }

      const { midLon: midLonRounded, midLat: midLatRounded } = edgeGapMid(
        pair.a.coord,
        pair.b.coord
      );
      const _gid = edgeGapStableId(kind, pair.a.coord, pair.b.coord);

      const withinKindCap = pair.gapM <= maxBridgeForKind(kind, options);
      let shouldBridge =
        withinKindCap && shouldBridgeKind(kind, options.bridgeMidRoad);
      let skippedWorkBoundary = false;
      if (
        shouldBridge &&
        blocksBridgeOnWorkBoundary(kind) &&
        isOneSidedWorkBoundaryBridge(pair.a.coord, pair.b.coord, options)
      ) {
        shouldBridge = false;
        skippedWorkBoundary = true;
        diagnostics.skippedWorkBoundary++;
      }
      if (shouldBridge) {
        const aLen = edgeLengthMeters(
          edges[pair.a.edgeIndex]!.geometry.coordinates
        );
        const bLen = edgeLengthMeters(
          edges[pair.b.edgeIndex]!.geometry.coordinates
        );
        // 短スタブ端はハブとして複数本線に繋ぐ（使用済みにしない）
        if (aLen >= GAP_STUB_HUB_MAX_M) used.add(ka);
        if (bLen >= GAP_STUB_HUB_MAX_M) used.add(kb);
        if (aLen < GAP_STUB_HUB_MAX_M && bLen < GAP_STUB_HUB_MAX_M) {
          used.add(ka);
          used.add(kb);
        }
        diagnostics.bridged++;
        bridgedThisRound++;
        bridges.push(
          lineString([pair.a.coord, pair.b.coord], {
            _gapBridge: true,
            _gid,
            kind,
            gapM: pair.gapM,
            angleToClDeg,
            midLon: midLonRounded,
            midLat: midLatRounded,
            edgeA: pair.a.edgeIndex,
            edgeB: pair.b.edgeIndex,
          })
        );
      }

      const gapKey = `${_gid}|${ka}|${kb}`;
      if (!emittedGapKeys.has(gapKey)) {
        emittedGapKeys.add(gapKey);
        gapFeatures.push(
          lineString([pair.a.coord, pair.b.coord], {
            kind,
            gapM: pair.gapM,
            angleToClDeg,
            bridged: shouldBridge,
            skippedWorkBoundary,
            _gid,
            midLon: midLonRounded,
            midLat: midLatRounded,
            nearClM: cl?.distToLineM ?? null,
            nearClEndM: cl?.distToEndpointM ?? null,
            edgeA: pair.a.edgeIndex,
            edgeB: pair.b.edgeIndex,
            overlapEdgeA: coverA?.edgeIndex ?? null,
            overlapDistA: coverA?.distM ?? null,
            overlapEdgeB: coverB?.edgeIndex ?? null,
            overlapDistB: coverB?.distM ?? null,
          })
        );
      }
    }

    // 初回以外で新規橋が無ければ打ち切り（reuse スキップだけの再探索は不要）
    if (round > 0 && bridgedThisRound === 0) break;
    // 初回で reuse スキップが無ければ追加ラウンド不要
    if (round === 0 && diagnostics.skippedEndpointReuse === 0) break;
  }

  return {
    edges: [...edges, ...bridges],
    gapFeatures,
    diagnostics,
  };
}
