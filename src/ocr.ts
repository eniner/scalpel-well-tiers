import { createWorker, type Worker } from 'tesseract.js'
import type { Word } from './segment'

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

/** Canvas-preprocess (grayscale + contrast-normalize + 3x upscale, the spike-proven
 *  recipe) then OCR. Returned word boxes are scaled back to original frame px. */
export async function runOcr(frame: Frame): Promise<Word[]> {
  const src = document.createElement('canvas')
  src.width = frame.width
  src.height = frame.height
  const sctx = src.getContext('2d')
  if (!sctx) return []
  sctx.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height), 0, 0)

  const img = sctx.getImageData(0, 0, src.width, src.height)
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
  sctx.putImageData(img, 0, 0)

  const scale = Math.min(3, Math.max(1, Math.round(3600 / frame.width)))
  const up = document.createElement('canvas')
  up.width = src.width * scale
  up.height = src.height * scale
  const uctx = up.getContext('2d')
  if (!uctx) return []
  uctx.imageSmoothingEnabled = true
  uctx.drawImage(src, 0, 0, up.width, up.height)

  const worker = await getWorker()
  const { data } = await worker.recognize(up)
  const words =
    (data as unknown as { words?: { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[] }).words ?? []
  return words.map((wd) => ({
    text: wd.text,
    confidence: wd.confidence,
    bbox: { x0: wd.bbox.x0 / scale, y0: wd.bbox.y0 / scale, x1: wd.bbox.x1 / scale, y1: wd.bbox.y1 / scale },
  }))
}
