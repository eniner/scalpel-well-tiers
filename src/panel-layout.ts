import type { GameCapture } from '@scalpelpoe/plugin-sdk'
import {
  DEFAULT_ROW_COUNT,
  FIXED_LIST_TOP_IN_PANEL,
  MAX_ROW_COUNT,
  MIN_ROW_COUNT,
  rewardRowBandsForCount,
  SCAN_BOTTOM_IN_PANEL,
  SCAN_TOP_IN_PANEL,
  TEXT_LEFT_IN_PANEL,
  TEXT_RIGHT_IN_PANEL,
  type PanelRect,
} from './panel-geometry'

export interface RowBandDetectResult {
  bands: Array<{ y: number; h: number }>
  method: 'layout-count' | 'fixed-fallback'
  peakCount: number
}

/** Light reward text on brown parchment — not full-frame grayscale. */
function isRewardTextPixel(r: number, g: number, b: number): boolean {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b
  if (lum < 118) return false
  if (r < 95 || g < 85) return false
  return lum - Math.min(r, g, b) > 28
}

/** Sum of text-like pixels per scanline inside the reward text column. */
export function horizontalTextProjection(
  frame: Pick<GameCapture, 'pixels' | 'width' | 'height'>,
  panel: PanelRect,
  topFrac = SCAN_TOP_IN_PANEL,
  bottomFrac = SCAN_BOTTOM_IN_PANEL,
): { y0: number; y1: number; values: Float32Array } {
  const listTop = panel.y + panel.h * topFrac
  const listBottom = panel.y + panel.h * bottomFrac
  const x0 = Math.round(panel.x + panel.w * TEXT_LEFT_IN_PANEL)
  const x1 = Math.round(panel.x + panel.w * TEXT_RIGHT_IN_PANEL)
  const y0 = Math.max(0, Math.round(listTop))
  const y1 = Math.min(frame.height, Math.round(listBottom))
  const h = y1 - y0
  const values = new Float32Array(h)
  const px = frame.pixels
  const w = frame.width

  for (let y = y0; y < y1; y++) {
    let count = 0
    const row = y * w * 4
    for (let x = x0; x < x1; x++) {
      const i = row + x * 4
      if (isRewardTextPixel(px[i]!, px[i + 1]!, px[i + 2]!)) count++
    }
    values[y - y0] = count
  }
  return { y0, y1, values }
}

function smooth(arr: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(arr.length)
  for (let i = 0; i < arr.length; i++) {
    let sum = 0
    let n = 0
    for (let d = -radius; d <= radius; d++) {
      const j = i + d
      if (j < 0 || j >= arr.length) continue
      sum += arr[j]!
      n++
    }
    out[i] = sum / n
  }
  return out
}

function mergePeaks(indices: number[], smoothed: Float32Array, minGap: number): number[] {
  const merged: number[] = []
  for (const p of indices) {
    if (merged.length === 0 || p - merged[merged.length - 1]! > minGap) merged.push(p)
    else if (smoothed[p]! > smoothed[merged[merged.length - 1]!]!) merged[merged.length - 1] = p
  }
  return merged
}

function findPeakIndices(smoothed: Float32Array, threshold: number): number[] {
  const peaks: number[] = []
  for (let i = 2; i < smoothed.length - 2; i++) {
    const v = smoothed[i]!
    if (v < threshold) continue
    if (v >= smoothed[i - 1]! && v >= smoothed[i + 1]!) peaks.push(i)
  }
  return peaks
}

function filterPeakCenters(centers: number[], panel: PanelRect): number[] {
  const listStart = panel.y + panel.h * FIXED_LIST_TOP_IN_PANEL
  const listEnd = panel.y + panel.h * SCAN_BOTTOM_IN_PANEL * 0.96
  return centers.filter((y) => y >= listStart - 8 && y <= listEnd)
}

/** Count rows from text layout peaks; place OCR bands on calibrated grid for that count. */
export function detectRewardRowBands(
  frame: Pick<GameCapture, 'pixels' | 'width' | 'height'>,
  panel: PanelRect,
): RowBandDetectResult {
  const { y0, y1, values } = horizontalTextProjection(frame, panel)
  const listH = y1 - y0
  if (listH < 40) {
    return {
      bands: rewardRowBandsForCount(panel, DEFAULT_ROW_COUNT),
      method: 'fixed-fallback',
      peakCount: 0,
    }
  }

  const smoothed = smooth(values, 3)
  const avg = [...smoothed].reduce((a, b) => a + b, 0) / smoothed.length

  let minGap = listH / MAX_ROW_COUNT
  let threshold = Math.max(8, avg * 0.35)
  let peakIdx = findPeakIndices(smoothed, threshold)
  let merged = mergePeaks(peakIdx, smoothed, minGap)

  if (merged.length < MIN_ROW_COUNT) {
    threshold = Math.max(6, avg * 0.22)
    peakIdx = findPeakIndices(smoothed, threshold)
    merged = mergePeaks(peakIdx, smoothed, minGap)
  }

  while (merged.length > MAX_ROW_COUNT && minGap < listH * 0.14) {
    minGap *= 1.12
    merged = mergePeaks(peakIdx, smoothed, minGap)
  }

  const filtered = filterPeakCenters(
    merged.map((p) => y0 + p),
    panel,
  )

  if (filtered.length >= MIN_ROW_COUNT && filtered.length <= MAX_ROW_COUNT) {
    return {
      bands: rewardRowBandsForCount(panel, filtered.length),
      method: 'layout-count',
      peakCount: filtered.length,
    }
  }

  const hint = filtered.length >= MIN_ROW_COUNT ? filtered.length : DEFAULT_ROW_COUNT
  return {
    bands: rewardRowBandsForCount(panel, Math.min(hint, MAX_ROW_COUNT)),
    method: 'fixed-fallback',
    peakCount: filtered.length,
  }
}
