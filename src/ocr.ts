import { createWorker, PSM, type Worker } from 'tesseract.js'
import type { Line, Word } from './segment'

/** Sink for tesseract's own progress events (worker init + recognize), so the UI
 *  can show what the engine is doing during the multi-second OCR. Set by the
 *  caller around an OCR run and cleared (null) when idle. */
type ProgressSink = (status: string, progress: number) => void
let progressSink: ProgressSink | null = null
export function setOcrProgress(cb: ProgressSink | null): void {
  progressSink = cb
}

// Two workers so the base-tooltip and options passes can OCR concurrently.
const POOL_SIZE = 2
// Restrict recognition to the characters PoE mod/base text uses. (LSTM applies
// this weakly, so it is mostly belt-and-braces, but it is harmless.)
const CHAR_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 %+-.,:'()/"

/** Page-seg mode per pass. 'auto' = full layout analysis. 'block' = single
 *  uniform block (cropped tooltip/options - skips layout). 'column' = single
 *  column of variable-size text (Runeshape reward list). 'sparse' = find text
 *  anywhere with no layout analysis (the scout, which only needs to locate the
 *  hint/confirm tokens across a big region) - the cheapest mode. */
export type OcrMode = 'auto' | 'block' | 'column' | 'sparse' | 'line'
const psmFor = (mode: OcrMode): PSM =>
  mode === 'block'
    ? PSM.SINGLE_BLOCK
    : mode === 'column'
      ? PSM.SINGLE_COLUMN
      : mode === 'sparse'
        ? PSM.SPARSE_TEXT
        : mode === 'line'
          ? PSM.SINGLE_LINE
          : PSM.AUTO

interface Pooled {
  worker: Worker
  psm: PSM
}
let poolP: Promise<Pooled[]> | null = null
const idle: Pooled[] = []
const waiters: ((p: Pooled) => void)[] = []

async function makeWorker(): Promise<Pooled> {
  const worker = await createWorker('eng', undefined, {
    logger: (m: { status?: string; progress?: number }) => {
      if (progressSink) progressSink(m.status ?? '', typeof m.progress === 'number' ? m.progress : 0)
    },
  })
  await worker.setParameters({ tessedit_char_whitelist: CHAR_WHITELIST })
  return { worker, psm: PSM.AUTO } // createWorker initialises in AUTO
}

/** Lazily create the worker pool. A failed init resets the cache so a later call
 *  retries instead of being stuck with a poisoned promise. */
function initPool(): Promise<Pooled[]> {
  if (!poolP)
    poolP = Promise.all(Array.from({ length: POOL_SIZE }, makeWorker))
      .then((ws) => {
        idle.push(...ws)
        return ws
      })
      .catch((e) => {
        poolP = null
        throw e
      })
  return poolP
}

async function acquire(): Promise<Pooled> {
  await initPool()
  const p = idle.pop()
  return p ?? new Promise<Pooled>((res) => waiters.push(res))
}

function release(p: Pooled): void {
  const next = waiters.shift()
  if (next) next(p)
  else idle.push(p)
}

/** Kick off pool creation ahead of the first OCR (e.g. at plugin load) so the
 *  multi-second engine init is paid in the background, not on the first hotkey. */
export function warmWorkers(): void {
  void initPool().catch(() => {})
}

interface Frame {
  pixels: Uint8ClampedArray
  width: number
  height: number
}
export interface Region {
  x: number
  y: number
  w: number
  h: number
}
export interface OcrResult {
  words: Word[]
  lines: Line[]
}

export type OcrPreprocess = 'none' | 'reward-text'

type TW = { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }

const MIN_WORD_CONF = 40

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))
  return sorted[idx]
}

function lineScore(text: string): number {
  let s = text.length
  if (/\d+\s*[xX]/.test(text)) s += 60
  if (/\b(orb|prism|bauble|uncut|greater|lesser|jewell|rune|gem)\b/i.test(text)) s += 40
  return s
}

/** Deterministic Y-clustering of OCR words into reward rows. Tesseract's own line
 *  layout varies scan-to-scan in SINGLE_BLOCK mode; this is stable given the same words. */
export function clusterWordsToLines(words: Word[], lineGap: number, minConf = MIN_WORD_CONF): Line[] {
  const usable = words.filter((w) => w.confidence >= minConf && w.text.trim())
  usable.sort((a, b) => (a.bbox.y0 + a.bbox.y1) / 2 - (b.bbox.y0 + b.bbox.y1) / 2 || a.bbox.x0 - b.bbox.x0)

  const rows: Word[][] = []
  for (const w of usable) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2
    let row = rows.find((r) => Math.abs((r[0].bbox.y0 + r[0].bbox.y1) / 2 - cy) <= lineGap)
    if (!row) {
      row = []
      rows.push(row)
    }
    row.push(w)
  }

  return rows
    .map((rowWords) => {
      rowWords.sort((a, b) => a.bbox.x0 - b.bbox.x0)
      const text = rowWords
        .map((w) => w.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      const real = rowWords.filter((w) => w.text.replace(/[^A-Za-z0-9]/g, '').length >= 2)
      const bw = real.length ? real : rowWords
      const x0 = Math.min(...bw.map((w) => w.bbox.x0))
      const y0 = Math.min(...bw.map((w) => w.bbox.y0))
      const x1 = Math.max(...bw.map((w) => w.bbox.x1))
      const y1 = Math.max(...bw.map((w) => w.bbox.y1))
      return { text, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }
    })
    .filter((l) => l.text.length > 0)
    .sort((a, b) => a.box.y - b.box.y)
}

/** Merge tess lines + word-clustered lines, keeping the strongest read per row. */
export function stabilizeRewardLines(tessLines: Line[], words: Word[], lineGap: number): Line[] {
  const clustered = clusterWordsToLines(words, lineGap)
  const pool = [...tessLines, ...clustered]
  if (pool.length === 0) return []

  const buckets = new Map<number, Line[]>()
  for (const l of pool) {
    const key = Math.round(l.box.y / lineGap)
    const list = buckets.get(key) ?? []
    list.push(l)
    buckets.set(key, list)
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, group]) => group.sort((a, b) => lineScore(b.text) - lineScore(a.text))[0])
}

function isRewardTextPixel(r: number, g: number, b: number): boolean {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b
  if (lum < 118) return false
  if (r < 95 || g < 85) return false
  return lum - Math.min(r, g, b) > 28
}

function applyRewardTextMask(img: ImageData): void {
  for (let i = 0; i < img.data.length; i += 4) {
    const r = img.data[i]!
    const g = img.data[i + 1]!
    const b = img.data[i + 2]!
    const v = isRewardTextPixel(r, g, b) ? 255 : 0
    img.data[i] = v
    img.data[i + 1] = v
    img.data[i + 2] = v
    img.data[i + 3] = 255
  }
}

/** Crop the captured frame to `region`, scale it so its width is ~`targetW`, grayscale-
 *  normalize, and OCR. Returns words (for base detection) and tesseract's native lines
 *  (for option matching), with all boxes mapped back to original frame px. Cropping to
 *  the option strip and scaling it UP keeps the mod text large and the OCR stable. */
export async function ocrRegion(
  frame: Frame,
  region: Region,
  targetW: number,
  mode: OcrMode = 'auto',
  preprocess: OcrPreprocess = 'none',
): Promise<OcrResult> {
  const rx = Math.max(0, Math.round(region.x))
  const ry = Math.max(0, Math.round(region.y))
  const rw = Math.max(1, Math.min(Math.round(region.w), frame.width - rx))
  const rh = Math.max(1, Math.min(Math.round(region.h), frame.height - ry))
  const scale = Math.min(3, Math.max(0.5, targetW / rw))
  const outW = Math.max(1, Math.round(rw * scale))
  const outH = Math.max(1, Math.round(rh * scale))

  const full = document.createElement('canvas')
  full.width = frame.width
  full.height = frame.height
  const fctx = full.getContext('2d')
  if (!fctx) return { words: [], lines: [] }
  fctx.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height), 0, 0)

  const out = document.createElement('canvas')
  out.width = outW
  out.height = outH
  const octx = out.getContext('2d')
  if (!octx) return { words: [], lines: [] }
  octx.imageSmoothingEnabled = false
  octx.drawImage(full, rx, ry, rw, rh, 0, 0, outW, outH)

  const img = octx.getImageData(0, 0, outW, outH)
  if (preprocess === 'reward-text') {
    applyRewardTextMask(img)
    octx.putImageData(img, 0, 0)
  } else {
    const grays: number[] = []
    for (let i = 0; i < img.data.length; i += 4) {
      const g = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
      grays.push(g)
    }
    const lo = percentile(grays, 8)
    const hi = percentile(grays, 92)
    const range = Math.max(1, hi - lo)
    for (let i = 0; i < img.data.length; i += 4) {
      const g = grays[i / 4]
      const v = Math.max(0, Math.min(255, ((g - lo) / range) * 255))
      img.data[i] = v
      img.data[i + 1] = v
      img.data[i + 2] = v
    }
    octx.putImageData(img, 0, 0)
  }

  // Grab a worker from the pool, set this pass's page-seg mode if it changed,
  // recognize, then release it. Holding the worker across both calls keeps the
  // setParameters/recognize pair atomic when two passes run concurrently.
  const psm = psmFor(mode)
  const p = await acquire()
  let raw: { words?: TW[]; lines?: { words?: TW[] }[] } = {}
  try {
    if (p.psm !== psm) {
      await p.worker.setParameters({ tessedit_pageseg_mode: psm })
      p.psm = psm
    }
    const { data } = await p.worker.recognize(out, {}, { blocks: true })
    raw = data as unknown as { words?: TW[]; lines?: { words?: TW[] }[] }
  } finally {
    release(p)
  }
  const inv = 1 / scale
  const fx = (x: number) => rx + x * inv
  const fy = (y: number) => ry + y * inv
  const d = raw
  const words: Word[] = (d.words ?? []).map((w) => ({
    text: w.text,
    confidence: w.confidence,
    bbox: { x0: fx(w.bbox.x0), y0: fy(w.bbox.y0), x1: fx(w.bbox.x1), y1: fy(w.bbox.y1) },
  }))
  const lines: Line[] = []
  for (const l of d.lines ?? []) {
    const kept = (l.words ?? []).filter((w) => w.confidence >= MIN_WORD_CONF)
    const text = kept
      .map((w) => w.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    // Position the box from real words only (>=3 alphanumerics), so far-left
    // decorative-border junk chars do not drag the box (and the label column) left.
    const real = kept.filter((w) => w.text.replace(/[^A-Za-z0-9]/g, "").length >= 3)
    const bw = real.length ? real : kept
    const x0 = Math.min(...bw.map((w) => fx(w.bbox.x0)))
    const y0 = Math.min(...bw.map((w) => fy(w.bbox.y0)))
    const x1 = Math.max(...bw.map((w) => fx(w.bbox.x1)))
    const y1 = Math.max(...bw.map((w) => fy(w.bbox.y1)))
    lines.push({ text, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } })
  }
  return { words, lines }
}
