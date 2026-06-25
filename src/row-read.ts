import type { GameCapture } from '@scalpelpoe/plugin-sdk'
import { detectRewardRowBands } from './panel-layout'
import { TEXT_LEFT_IN_PANEL, TEXT_RIGHT_IN_PANEL, type PanelRect } from './panel-geometry'
import { pickBestRowDecode, RUNESHAPE_READER_VERSION } from './decode-row'
import { ocrRegion, stabilizeRewardLines } from './ocr'
import { expandTruncatedRewardName, type Candidate } from './rewards'
import type { Box, Line } from './segment'

export const PANEL_TOP_FRAC = 0.05
export const PANEL_W_FRAC = 0.56
export const PANEL_H_FRAC = 0.82

const ROW_TARGET_W = 1800

export function panelRect(frame: Pick<GameCapture, 'height'>): PanelRect {
  const y = frame.height * PANEL_TOP_FRAC
  const h = frame.height * PANEL_H_FRAC - y
  return { x: 0, y, w: frame.height * PANEL_W_FRAC, h }
}

function textColumn(slot: { y: number; h: number }, panel: PanelRect): { x: number; y: number; w: number; h: number } {
  return {
    x: panel.x + panel.w * TEXT_LEFT_IN_PANEL,
    y: slot.y,
    w: panel.w * (TEXT_RIGHT_IN_PANEL - TEXT_LEFT_IN_PANEL),
    h: slot.h,
  }
}

function pickRowText(lines: Line[], words: import('./segment').Word[], lineGap: number): string {
  const stable = stabilizeRewardLines(lines, words, lineGap)
  const pool = stable.length > 0 ? stable : lines
  const fromLine = pool
    .map((l) => l.text.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0]
  if (fromLine) return fromLine
  return words
    .map((w) => w.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function ocrRowPasses(frame: GameCapture, region: { x: number; y: number; w: number; h: number }): Promise<string[]> {
  const lineGap = Math.max(6, region.h * 0.35)
  const [block, line, column, masked] = await Promise.all([
    ocrRegion(frame, region, ROW_TARGET_W, 'block'),
    ocrRegion(frame, region, ROW_TARGET_W, 'line'),
    ocrRegion(frame, region, ROW_TARGET_W, 'column'),
    ocrRegion(frame, region, ROW_TARGET_W, 'block', 'reward-text'),
  ])
  const reads: string[] = []
  for (const pass of [block, line, column, masked]) {
    const stable = stabilizeRewardLines(pass.lines, pass.words, lineGap)
    for (const l of stable) reads.push(l.text.trim())
    reads.push(pickRowText(pass.lines, pass.words, lineGap))
  }
  return [...new Set(reads.filter((r) => r.length > 2))]
}

export interface RowReadResult {
  lines: Line[]
  candidates: Candidate[]
  method: string
}

/** Detect all visible reward rows, OCR each band, decode against catalog. */
export async function readRewardRows(
  frame: GameCapture,
  onRow?: (index: number, total: number) => void,
): Promise<RowReadResult> {
  const panel = panelRect(frame)
  const { bands, method: detectMethod, peakCount } = detectRewardRowBands(frame, panel)
  const lines: Line[] = []
  const candidates: Candidate[] = []

  for (let i = 0; i < bands.length; i++) {
    onRow?.(i + 1, bands.length)
    const region = textColumn(bands[i]!, panel)
    const reads = await ocrRowPasses(frame, region)
    const decoded = pickBestRowDecode(reads)
    const box: Box = { x: region.x, y: region.y, w: region.w, h: region.h }

    if (decoded) {
      const name = expandTruncatedRewardName(decoded.name)
      lines.push({ text: decoded.raw, box })
      candidates.push({ qty: decoded.qty, name, box, explicit: true })
    } else {
      const fallback = reads.find((r) => r.length > 2) ?? ''
      lines.push({ text: fallback || `(row ${i + 1})`, box })
      candidates.push({ qty: 1, name: fallback || 'Unread reward', box, explicit: true })
    }
  }

  const detectLabel = detectMethod === 'layout-count' ? `layout-count(${peakCount})` : `fixed-fallback(${bands.length})`
  return {
    lines,
    candidates,
    method: `v${RUNESHAPE_READER_VERSION} ${detectLabel}+masked-ocr (${bands.length} rows)`,
  }
}
