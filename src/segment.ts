export interface Word {
  text: string
  bbox: { x0: number; y0: number; x1: number; y1: number }
  confidence: number
}
export interface Option {
  text: string
  box: { x: number; y: number; w: number; h: number }
}

/** Cluster OCR words into lines (vertical overlap), then group lines into options (vertical gap).
 *  Within an option, words are read top-to-bottom by line, left-to-right within a line - OCR gives
 *  same-line words slightly different y0, so a naive y0-then-x0 sort scrambles reading order. */
export function segment(words: Word[], opts: { minConfidence?: number } = {}): Option[] {
  const minConf = opts.minConfidence ?? 50
  const kept = words.filter((w) => w.confidence >= minConf && w.text.trim())
  if (kept.length === 0) return []
  const sorted = [...kept].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)
  const lines: Word[][] = []
  for (const word of sorted) {
    const line = lines.find((l) => {
      const ly = l[0].bbox
      return word.bbox.y0 < ly.y1 && word.bbox.y1 > ly.y0
    })
    if (line) line.push(word)
    else lines.push([word])
  }
  const heights = lines.map((l) => Math.max(...l.map((w) => w.bbox.y1 - w.bbox.y0)))
  const medianH = heights.slice().sort((a, b) => a - b)[Math.floor(heights.length / 2)] || 12
  const groups: Word[][][] = []
  let prevBottom = -Infinity
  for (const line of lines) {
    const top = Math.min(...line.map((w) => w.bbox.y0))
    if (top - prevBottom > medianH * 1.5) groups.push([line])
    else groups[groups.length - 1].push(line)
    prevBottom = Math.max(...line.map((w) => w.bbox.y1))
  }
  return groups.map((g) => {
    const orderedLines = g
      .map((line) => [...line].sort((a, b) => a.bbox.x0 - b.bbox.x0))
      .sort((l1, l2) => Math.min(...l1.map((w) => w.bbox.y0)) - Math.min(...l2.map((w) => w.bbox.y0)))
    const ws = orderedLines.flat()
    const text = ws.map((w) => w.text).join(' ')
    const x = Math.min(...ws.map((w) => w.bbox.x0))
    const y = Math.min(...ws.map((w) => w.bbox.y0))
    const w2 = Math.max(...ws.map((w) => w.bbox.x1)) - x
    const h = Math.max(...ws.map((w) => w.bbox.y1)) - y
    return { text, box: { x, y, w: w2, h } }
  })
}
