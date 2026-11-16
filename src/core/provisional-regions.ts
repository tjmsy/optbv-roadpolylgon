/**
 * ADR 002 stage 3: provisional CL と交わる split-region の道路面採用。
 *
 * - provisional-closed: bbox 非接触 ∧ 信頼境バリア近傍（交差点ポケット）
 * - provisional-arterial: 両側縁支持のある太い幹線（bbox 貫通可）
 *
 * 縁貫通カット等の短尺 scrap（&lt; CL_SAFE_MIN_LENGTH_M）は artifact 用に
 * provisional 残すが、採用根拠には使わない（誤塗り防止）。
 *
 * @see docs/research/07-centerline-trust-barriers.md
 * @see docs/adr/002-centerline-trust-barriers.md
 */
import type { Feature, Polygon } from "geojson";
import {
  intersectingCenterlines,
  majorityVerticesWithinCenterlineDistance,
  maxVertexDistanceToCenterlines,
} from "./centerline-distance.js";
import type { Bbox, LineFeature } from "./types.js";
import {
  emptyProvisionalRegionDiagnostics,
  MAX_PROVISIONAL_VERTEX_TO_CL_DIST_M,
  PROVISIONAL_ARTERIAL_MAX_HALF_WIDTH_M,
  type ProvisionalRegionDiagnostics,
} from "./provisional-region-config.js";
import {
  isMeaningfulProvisional,
  isNearAnyTrustBarrier,
  provisionalHasDualEdgeSupport,
  touchesWorkBbox,
  workBboxEdgeLines,
} from "./provisional-region-support.js";
export * from "./provisional-region-config.js";

function adoptFeature(
  feature: Feature<Polygon>,
  selection: "provisional-closed" | "provisional-arterial"
): Feature<Polygon> {
  return {
    ...feature,
    properties: {
      ...(feature.properties ?? {}),
      _selection: selection,
    },
  };
}

/**
 * safe 選別後の残りセルから、閉じた provisional ポケット／両側縁の幹線を採用する。
 */
export function selectProvisionalClosedRegions(
  splitPolygons: Feature<Polygon>[],
  provisional: LineFeature[],
  barriers: LineFeature[],
  bbox: Bbox,
  bufferDistanceM: number,
  alreadyAdopted: Feature<Polygon>[] = [],
  edges: LineFeature[] = []
): { adopted: Feature<Polygon>[]; diagnostics: ProvisionalRegionDiagnostics } {
  const diagnostics = emptyProvisionalRegionDiagnostics();
  const adopted: Feature<Polygon>[] = [];
  if (provisional.length === 0) return { adopted, diagnostics };

  const already = new Set(alreadyAdopted);
  const bboxEdges = workBboxEdgeLines(bbox);
  const barrierNearM = bufferDistanceM + 1;

  for (const feature of splitPolygons) {
    diagnostics.candidateCount++;
    try {
      if (already.has(feature)) {
        diagnostics.skippedAlreadySafe++;
        continue;
      }

      const hittingProvisional = intersectingCenterlines(feature, provisional);
      if (hittingProvisional.length === 0) {
        diagnostics.skippedNoProvisionalIntersect++;
        continue;
      }
      const provisionalForCell = hittingProvisional.filter(
        isMeaningfulProvisional
      );
      if (provisionalForCell.length === 0) {
        diagnostics.skippedShortProvisionalOnly++;
        continue;
      }

      const ring = feature.geometry.coordinates[0] ?? [];
      if (ring.length === 0) {
        diagnostics.skippedError++;
        continue;
      }

      const touchesBbox = touchesWorkBbox(ring, bboxEdges, bufferDistanceM);
      const nearBarrier = isNearAnyTrustBarrier(ring, barriers, barrierNearM);
      const maxDistClosed = maxVertexDistanceToCenterlines(
        feature,
        provisionalForCell
      );

      // Path A: closed intersection pocket
      if (
        !touchesBbox &&
        nearBarrier &&
        maxDistClosed <= MAX_PROVISIONAL_VERTEX_TO_CL_DIST_M
      ) {
        adopted.push(adoptFeature(feature, "provisional-closed"));
        diagnostics.adoptedClosedCount++;
        diagnostics.adoptedCount++;
        continue;
      }

      // Path B: dual-edge arterial (may pierce bbox)
      const dualOk =
        edges.length > 0 &&
        provisionalHasDualEdgeSupport(
          provisionalForCell,
          edges,
          PROVISIONAL_ARTERIAL_MAX_HALF_WIDTH_M
        );
      const arterialDist = majorityVerticesWithinCenterlineDistance(
        feature,
        provisionalForCell,
        PROVISIONAL_ARTERIAL_MAX_HALF_WIDTH_M
      );

      if (dualOk && arterialDist.ok) {
        adopted.push(adoptFeature(feature, "provisional-arterial"));
        diagnostics.adoptedArterialCount++;
        diagnostics.adoptedCount++;
        continue;
      }

      if (!dualOk) {
        diagnostics.skippedNoDualEdge++;
        if (touchesBbox) diagnostics.skippedTouchesBbox++;
        else if (!nearBarrier) diagnostics.skippedFarFromBarrier++;
        continue;
      }
      diagnostics.skippedFarFromProvisional++;
    } catch {
      diagnostics.skippedError++;
    }
  }

  return { adopted, diagnostics };
}
