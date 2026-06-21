// Shared OCR geometry types. Line segmentation is delegated to tesseract's own
// layout analysis (see ocr.ts) - it is far more robust than hand-rolled clustering.
export interface Word {
  text: string
  bbox: { x0: number; y0: number; x1: number; y1: number }
  confidence: number
}
export interface Box {
  x: number
  y: number
  w: number
  h: number
}
export interface Line {
  text: string
  box: Box
}
