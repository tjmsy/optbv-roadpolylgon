/** 道路面頂点が safe/provisional CL から離れてよい上限（m） */
export const MAX_ROAD_VERTEX_TO_CL_DIST_M = 25;

/** 中庭内側判定で道路縁から離れているとみなす距離（m） */
export const COURTYARD_INTERIOR_EDGE_DIST_M = 20;

/** @deprecated Use MAX_ROAD_VERTEX_TO_CL_DIST_M */
export const MAX_ROAD_VERTEX_TO_SAFE_CL_DIST_M = MAX_ROAD_VERTEX_TO_CL_DIST_M;
