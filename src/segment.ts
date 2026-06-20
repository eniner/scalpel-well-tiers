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

function mkLine(words: Word[]): Line {
  const ws = [...words].sort((a, b) => a.bbox.x0 - b.bbox.x0)
  const text = ws.map((w) => w.text).join(' ')
  const x = Math.min(...ws.map((w) => w.bbox.x0))
  const y = Math.min(...ws.map((w) => w.bbox.y0))
  const w = Math.max(...ws.map((w) => w.bbox.x1)) - x
  const h = Math.max(...ws.map((w) => w.bbox.y1)) - y
  return { text, box: { x, y, w, h } }
}

/** Cluster OCR words into contiguous lines: group by row (y-center), then split a
 *  row wherever the horizontal gap exceeds ~2.5x line-height. The x-split keeps a
 *  side panel's text from merging with same-row text elsewhere (e.g. the inventory),
 *  which a y-only clustering would wrongly join into one line. */
export function toLines(words: Word[], opts: { minConfidence?: number } = {}): Line[] {
  const minConf = opts.minConfidence ?? 50
  const kept = words.filter((w) => w.confidence >= minConf && w.text.trim())
  if (kept.length === 0) return []
  const rows: Word[][] = []
  for (const w of [...kept].sort((a, b) => a.bbox.y0 - b.bbox.y0)) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2
    const h = w.bbox.y1 - w.bbox.y0
    const row = rows.find((r) => {
      const f = r[0].bbox
      return Math.abs((f.y0 + f.y1) / 2 - cy) < h * 0.6
    })
    if (row) row.push(w)
    else rows.push([w])
  }
  const lines: Line[] = []
  for (const row of rows) {
    let seg: Word[] = []
    for (const w of [...row].sort((a, b) => a.bbox.x0 - b.bbox.x0)) {
      if (seg.length) {
        const last = seg[seg.length - 1]
        const h = last.bbox.y1 - last.bbox.y0
        if (w.bbox.x0 - last.bbox.x1 > h * 2.5) {
          lines.push(mkLine(seg))
          seg = []
        }
      }
      seg.push(w)
    }
    if (seg.length) lines.push(mkLine(seg))
  }
  return lines.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
}
