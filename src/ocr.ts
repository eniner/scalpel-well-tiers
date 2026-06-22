import { createWorker, type Worker } from 'tesseract.js'
import type { Line, Word } from './segment'

let workerP: Promise<Worker> | null = null

/** Lazily create (and reuse) the tesseract worker. First call pays the init cost. */
export function getWorker(): Promise<Worker> {
  if (!workerP) workerP = createWorker('eng')
  return workerP
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

type TW = { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }

/** Crop the captured frame to `region`, scale it so its width is ~`targetW`, grayscale-
 *  normalize, and OCR. Returns words (for base detection) and tesseract's native lines
 *  (for option matching), with all boxes mapped back to original frame px. Cropping to
 *  the option strip and scaling it UP keeps the mod text large and the OCR stable. */
export async function ocrRegion(frame: Frame, region: Region, targetW: number): Promise<OcrResult> {
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
  octx.imageSmoothingEnabled = true
  octx.drawImage(full, rx, ry, rw, rh, 0, 0, outW, outH)

  const img = octx.getImageData(0, 0, outW, outH)
  let lo = 255
  let hi = 0
  for (let i = 0; i < img.data.length; i += 4) {
    const g = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
    img.data[i] = g
    img.data[i + 1] = g
    img.data[i + 2] = g
    if (g < lo) lo = g
    if (g > hi) hi = g
  }
  const range = Math.max(1, hi - lo)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = ((img.data[i] - lo) / range) * 255
    img.data[i] = v
    img.data[i + 1] = v
    img.data[i + 2] = v
  }
  octx.putImageData(img, 0, 0)

  const worker = await getWorker()
  const { data } = await worker.recognize(out, {}, { blocks: true })
  const inv = 1 / scale
  const fx = (x: number) => rx + x * inv
  const fy = (y: number) => ry + y * inv
  const d = data as unknown as { words?: TW[]; lines?: { words?: TW[] }[] }
  const words: Word[] = (d.words ?? []).map((w) => ({
    text: w.text,
    confidence: w.confidence,
    bbox: { x0: fx(w.bbox.x0), y0: fy(w.bbox.y0), x1: fx(w.bbox.x1), y1: fy(w.bbox.y1) },
  }))
  const lines: Line[] = []
  for (const l of d.lines ?? []) {
    const kept = (l.words ?? []).filter((w) => w.confidence >= 55)
    const text = kept
      .map((w) => w.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    // Position the box from real words only (>=2 alphanumerics), so far-left
    // decorative-border junk chars do not drag the box (and the label column) left.
    const real = kept.filter((w) => w.text.replace(/[^A-Za-z0-9]/g, "").length >= 2)
    const bw = real.length ? real : kept
    const x0 = Math.min(...bw.map((w) => fx(w.bbox.x0)))
    const y0 = Math.min(...bw.map((w) => fy(w.bbox.y0)))
    const x1 = Math.max(...bw.map((w) => fx(w.bbox.x1)))
    const y1 = Math.max(...bw.map((w) => fy(w.bbox.y1)))
    lines.push({ text, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } })
  }
  return { words, lines }
}
