/**
 * 道路面判定に使う RdCL の信頼区間を抽出する。
 *
 * - safe: 縁近傍コリドー内。道路面選別に使う
 * - provisional: コリドー外だが非道路と断定できない（交差点中央など）。選別には使わない
 * - excluded: トンネル・徒歩道・行き止まり外側・未橋渡し gap の両側支持不足など
 *
 * 判定手順:
 * 1. トンネル / 徒歩道 vt_code の CL は全体を excluded（RdEdg が無い／対応しない）
 * 2. CL と全 edge / gap の交差点を求め、交差点で CL セグメントを分割
 *    （overlap gap は見かけの継ぎ目で実開口ではないため信頼判定から除外）
 * 3. 未橋渡し gap 接触: コリドー＋両側支持を満たせば safe、満たさなければ excluded
 * 4. それ以外: コリドーに沿って分割し、内側 → safe、外側 → provisional
 *
 * @see docs/research/07-centerline-trust-barriers.md
 */
import { lineString } from "@turf/helpers";
import type { Feature, LineString, Position } from "geojson";
import type { LineFeature } from "./types.js";
import {
  coordDistMeters,
  isSegmentInCorridor,
  lineLengthMeters,
  metersToDegPad,
  minDistToLineLocal,
  splitByCorridorDistance,
} from "./centerline-corridor.js";
export { lineHasMajorityDualSideEdgeSupport } from "./centerline-corridor.js";
import {
  cumulativeDistToSegment,
  findEdgeCrossings,
  splitAtCrossings,
} from "./centerline-crossings.js";
import {
  CL_CORRIDOR_MAX_DIST_M,
  CL_SAFE_MIN_LENGTH_M,
  RDCL_FOOTPATH_VT_CODES,
  RDCL_TUNNEL_VT_CODES,
  type CenterlineTrustDiagnostics,
  type CenterlineTrustResult,
  type ClTrustKind,
  type ClTrustReason,
} from "./centerline-trust-config.js";
export * from "./centerline-trust-config.js";
import { BBoxIndex } from "./spatial-index.js";
import {
  isOnRoadSideOfGapTermini,
  segmentTouchesAnyGap,
} from "./centerline-gap-termini.js";

function parseVtCode(vtCode: unknown): number | null {
  if (vtCode == null) return null;
  const n = typeof vtCode === "number" ? vtCode : Number(vtCode);
  return Number.isFinite(n) ? n : null;
}

/** RdCL の vt_code がトンネルか（数値・文字列両対応） */
export function isTunnelCenterlineCode(vtCode: unknown): boolean {
  const n = parseVtCode(vtCode);
  return n != null && RDCL_TUNNEL_VT_CODES.has(n);
}

/** RdCL の vt_code が徒歩道か（数値・文字列両対応） */
export function isFootpathCenterlineCode(vtCode: unknown): boolean {
  const n = parseVtCode(vtCode);
  return n != null && RDCL_FOOTPATH_VT_CODES.has(n);
}

function coordsToLineFeature(
  coords: Position[],
  baseProps: Record<string, unknown>,
  trust: ClTrustKind,
  reason: ClTrustReason
): LineFeature | null {
  if (coords.length < 2) return null;
  return lineString(coords, {
    ...baseProps,
    _clTrust: trust,
    _clTrustReason: reason,
  });
}

/**
 * 入力中心線を安全・保留・除外区間に分割する。
 *
 * 1. CL と edge / gap の交差点で CL を分割
 * 2. 各分割セグメントをコリドー／終端判定で safe / provisional / excluded に振り分け
 */
export function splitCenterlinesForRoadSelection(
  centerlines: LineFeature[],
  edges: LineFeature[],
  gapFeatures: Feature<LineString>[],
  options?: {
    corridorMaxDistM?: number;
  }
): CenterlineTrustResult {
  const corridorMaxDistM = options?.corridorMaxDistM ?? CL_CORRIDOR_MAX_DIST_M;

  const safe: LineFeature[] = [];
  const provisional: LineFeature[] = [];
  const excluded: LineFeature[] = [];
  const diagnostics: CenterlineTrustDiagnostics = {
    inputLineCount: centerlines.length,
    safeSegmentCount: 0,
    provisionalSegmentCount: 0,
    excludedSegmentCount: 0,
    corridorExcludedSegments: 0,
    corridorProvisionalSegments: 0,
    deadEndOutsideSegments: 0,
    deadEndAmbiguousSegments: 0,
    shortExcludedSegments: 0,
    tunnelExcludedSegments: 0,
    footpathExcludedSegments: 0,
    edgeCrossingCuts: 0,
    gapCrossingCuts: 0,
  };

  const pushSafe = (coords: Position[], baseProps: Record<string, unknown>) => {
    const feature = coordsToLineFeature(
      coords,
      baseProps,
      "safe",
      "dual-edge-support"
    );
    if (feature) {
      safe.push(feature);
      diagnostics.safeSegmentCount++;
    }
  };

  const pushProvisional = (
    coords: Position[],
    baseProps: Record<string, unknown>,
    reason: ClTrustReason = "corridor-uncertain"
  ) => {
    const feature = coordsToLineFeature(
      coords,
      baseProps,
      "provisional",
      reason
    );
    if (feature) {
      provisional.push(feature);
      diagnostics.provisionalSegmentCount++;
      diagnostics.corridorProvisionalSegments++;
    }
  };

  const pushExcluded = (
    coords: Position[],
    baseProps: Record<string, unknown>,
    reason: ClTrustReason
  ) => {
    const feature = coordsToLineFeature(coords, baseProps, "excluded", reason);
    if (!feature) return;
    excluded.push(feature);
    diagnostics.excludedSegmentCount++;
    if (reason === "segment-too-short") {
      diagnostics.shortExcludedSegments++;
    } else if (reason === "dead-end-outside") {
      diagnostics.deadEndOutsideSegments++;
    } else if (reason === "dead-end-ambiguous") {
      diagnostics.deadEndAmbiguousSegments++;
    } else if (reason === "tunnel-vt-code") {
      diagnostics.tunnelExcludedSegments++;
    } else if (reason === "footpath-vt-code") {
      diagnostics.footpathExcludedSegments++;
    } else if (reason === "insufficient-edge-support") {
      diagnostics.corridorExcludedSegments++;
    }
  };

  const emitByLength = (
    coords: Position[],
    baseProps: Record<string, unknown>,
    kind: "safe" | "provisional",
    provisionalReason: ClTrustReason = "corridor-uncertain"
  ) => {
    if (lineLengthMeters(coords) < CL_SAFE_MIN_LENGTH_M) {
      // 分割残骸を捨てず / excluded にしない（空白や「リスク」誤認を避ける）
      pushProvisional(coords, baseProps, provisionalReason);
      return;
    }
    if (kind === "safe") pushSafe(coords, baseProps);
    else pushProvisional(coords, baseProps, provisionalReason);
  };

  // overlap は端点が他縁線上にある継ぎ目で、開口でもダングリングでもない。
  // 信頼分割・終端側判定・両側支持の対象外にする（庭園路 CL 等の誤除外を防ぐ）。
  const trustGaps = gapFeatures.filter((g) => g.properties?.kind !== "overlap");
  // 分割は trustGaps 全件（bridged 含む）。道路終端の側判定も同集合の接触で行う。
  // 両側支持の追加要求は未橋渡し gap 接触時のみ（橋渡し済み mid-road の過剰除外を避ける）。
  const allGapBoundaries: LineFeature[] = trustGaps.map((g) =>
    lineString(g.geometry.coordinates, g.properties ?? {})
  );
  const unbridgedGaps: LineFeature[] = trustGaps
    .filter((g) => g.properties?.bridged !== true)
    .map((g) => lineString(g.geometry.coordinates, g.properties ?? {}));

  const edgeIndex = BBoxIndex.fromLineFeatures(edges);
  const gapIndex = BBoxIndex.fromLineFeatures(allGapBoundaries);
  const unbridgedGapIndex = BBoxIndex.fromLineFeatures(unbridgedGaps);

  for (const cl of centerlines) {
    const coords = cl.geometry.coordinates;
    const baseProps = { ...(cl.properties ?? {}) };

    if (coords.length < 2) continue;

    // トンネル RdCL（vt_code 2704 等）は縁が無い区間のため道路面選別から除外
    if (isTunnelCenterlineCode(baseProps.vt_code)) {
      pushExcluded(coords, baseProps, "tunnel-vt-code");
      continue;
    }

    // 徒歩道 RdCL（vt_code 2721 等）は対応する RdEdg が原則無いため除外
    if (isFootpathCenterlineCode(baseProps.vt_code)) {
      pushExcluded(coords, baseProps, "footpath-vt-code");
      continue;
    }

    // 1. edge / gap との交差点を求める
    const edgeCrossings = findEdgeCrossings(coords, edgeIndex);
    const gapCrossings = findEdgeCrossings(coords, gapIndex);
    diagnostics.edgeCrossingCuts += edgeCrossings.length;
    diagnostics.gapCrossingCuts += gapCrossings.length;
    const crossings = [...edgeCrossings, ...gapCrossings].sort(
      (a, b) =>
        cumulativeDistToSegment(coords, a.segIndex, a.point) -
        cumulativeDistToSegment(coords, b.segIndex, b.point)
    );
    const mergedCrossings: { segIndex: number; point: Position }[] = [];
    for (const c of crossings) {
      const last = mergedCrossings[mergedCrossings.length - 1];
      if (last && coordDistMeters(last.point, c.point) < 0.1) continue;
      mergedCrossings.push(c);
    }

    // 2. 交差点で CL を分割
    const segments = splitAtCrossings(coords, mergedCrossings);

    // 3. 各セグメントを信頼判定
    for (const seg of segments) {
      const anyGapTouch = segmentTouchesAnyGap(
        seg,
        gapIndex,
        minDistToLineLocal,
        metersToDegPad
      );
      const unbridgedGapTouch = segmentTouchesAnyGap(
        seg,
        unbridgedGapIndex,
        minDistToLineLocal,
        metersToDegPad
      );
      const gapSide = isOnRoadSideOfGapTermini(seg, anyGapTouch, edges);

      if (gapSide === "outside") {
        if (lineLengthMeters(seg) < CL_SAFE_MIN_LENGTH_M) {
          pushExcluded(seg, baseProps, "segment-too-short");
        } else {
          pushExcluded(seg, baseProps, "dead-end-outside");
        }
        continue;
      }
      if (gapSide === "ambiguous") {
        if (lineLengthMeters(seg) < CL_SAFE_MIN_LENGTH_M) {
          pushExcluded(seg, baseProps, "segment-too-short");
        } else {
          pushExcluded(seg, baseProps, "dead-end-ambiguous");
        }
        continue;
      }

      // 未橋渡し gap 接触: 両側支持を含む従来の厳格判定（失敗は excluded）
      if (unbridgedGapTouch.touchesGap) {
        const inCorridor = isSegmentInCorridor(
          seg,
          edgeIndex,
          corridorMaxDistM,
          true
        );
        if (inCorridor && lineLengthMeters(seg) >= CL_SAFE_MIN_LENGTH_M) {
          pushSafe(seg, baseProps);
        } else if (lineLengthMeters(seg) < CL_SAFE_MIN_LENGTH_M) {
          pushExcluded(seg, baseProps, "segment-too-short");
        } else {
          pushExcluded(seg, baseProps, "insufficient-edge-support");
        }
        continue;
      }

      // gap 非接触（または橋渡し済みのみ）: コリドーに沿って safe / provisional 分割
      const runs = splitByCorridorDistance(seg, edgeIndex, corridorMaxDistM);
      if (runs.length === 0) {
        pushExcluded(seg, baseProps, "segment-too-short");
        continue;
      }
      for (const run of runs) {
        emitByLength(
          run.coords,
          baseProps,
          run.inCorridor ? "safe" : "provisional",
          "corridor-uncertain"
        );
      }
    }
  }

  return { safe, provisional, excluded, diagnostics };
}
