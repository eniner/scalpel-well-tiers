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
export interface OcrResult {
  words: Word[]
  lines: Line[]
}

// Crop to the left portion (the well dialog + item tooltip live here; the inventory
// panel on the right is dropped - less to OCR and no false matches from item names).
const CROP_W_FRAC = 0.72
// Cap the OCR raster width so a 4K capture isn't 10s of tesseract; ~2000px keeps
// the well text legible while staying fast.
const TARGET_W = 2000

/** Crop + downscale + grayscale-normalize the captured frame, OCR it, and return
 *  both words (for base detection) and tesseract's native lines (for option
 *  matching). All boxes are mapped back to original frame px. */
export async function runOcr(frame: Frame): Promise<OcrResult> {
  const cropW = Math.max(1, Math.round(frame.width * CROP_W_FRAC))
  const ocrScale = Math.min(2, Math.max(0.5, TARGET_W / cropW))
  const outW = Math.max(1, Math.round(cropW * ocrScale))
  const outH = Math.max(1, Math.round(frame.height * ocrScale))

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
  octx.drawImage(full, 0, 0, cropW, frame.height, 0, 0, outW, outH)

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
  const inv = 1 / ocrScale
  type TW = { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }
  type TL = { words?: TW[]; bbox: { x0: number; y0: number; x1: number; y1: number } }
  const d = data as unknown as { words?: TW[]; lines?: TL[] }
  const words: Word[] = (d.words ?? []).map((w) => ({
    text: w.text,
    confidence: w.confidence,
    bbox: { x0: w.bbox.x0 * inv, y0: w.bbox.y0 * inv, x1: w.bbox.x1 * inv, y1: w.bbox.y1 * inv },
  }))
  const lines: Line[] = (d.lines ?? [])
    .map((l) => {
      const text = (l.words ?? [])
        .filter((w) => w.confidence >= 55)
        .map((w) => w.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      const b = l.bbox
      return { text, box: { x: b.x0 * inv, y: b.y0 * inv, w: (b.x1 - b.x0) * inv, h: (b.y1 - b.y0) * inv } }
    })
    .filter((l) => l.text)
  return { words, lines }
}
