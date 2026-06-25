/** Full list band scanned for row layout (fractions of panel height). */
export const SCAN_TOP_IN_PANEL = 0.07
export const SCAN_BOTTOM_IN_PANEL = 0.78

/** Calibrated fixed fallback for standard ~8-row pages when layout peaks fail. */
export const FIXED_LIST_TOP_IN_PANEL = 0.123
export const FIXED_LIST_BOTTOM_IN_PANEL = 0.566

export const TEXT_LEFT_IN_PANEL = 0.34
export const TEXT_RIGHT_IN_PANEL = 0.99

export const MIN_ROW_COUNT = 3
export const MAX_ROW_COUNT = 14
export const DEFAULT_ROW_COUNT = 8

export interface PanelRect {
  x: number
  y: number
  w: number
  h: number
}

export function fixedRewardRowBands(
  panel: PanelRect,
  want = DEFAULT_ROW_COUNT,
): Array<{ y: number; h: number }> {
  return rewardRowBandsForCount(panel, want)
}

/** Place N row OCR bands: calibrated top + 8-row spacing, compress when the list overflows the scan area. */
export function rewardRowBandsForCount(panel: PanelRect, count: number): Array<{ y: number; h: number }> {
  const n = Math.max(MIN_ROW_COUNT, Math.min(MAX_ROW_COUNT, count))
  const listTop = panel.y + panel.h * FIXED_LIST_TOP_IN_PANEL
  const maxBottom = panel.y + panel.h * SCAN_BOTTOM_IN_PANEL
  const calSpan = panel.h * (FIXED_LIST_BOTTOM_IN_PANEL - FIXED_LIST_TOP_IN_PANEL)
  const calRowH = calSpan / DEFAULT_ROW_COUNT
  const neededBottom = listTop + (n - 1) * calRowH + calRowH * 0.88
  const rowH = neededBottom <= maxBottom ? calRowH : (maxBottom - listTop) / n
  const bandH = rowH * 0.78
  return Array.from({ length: n }, (_, i) => ({
    y: listTop + i * rowH + rowH * 0.1,
    h: bandH,
  }))
}

export function peaksToRowBands(centers: number[], listH: number): Array<{ y: number; h: number }> {
  if (centers.length === 0) return []
  const spacings: number[] = []
  for (let i = 1; i < centers.length; i++) spacings.push(centers[i]! - centers[i - 1]!)
  const rowH =
    spacings.length > 0 ? spacings.reduce((a, b) => a + b, 0) / spacings.length : listH / centers.length
  const bandH = rowH * 0.78
  return centers.map((cy) => ({ y: cy - bandH * 0.5, h: bandH }))
}
