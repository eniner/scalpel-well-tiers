import { BASE_NAMES } from './dataset'
import type { Word } from './segment'

/** Find the item's base type in the OCR words by matching word-windows against the
 *  known base-type vocabulary. Returns the longest match (so "Gelid Staff" beats a
 *  spurious single-word hit) in original case, or null. The finite vocabulary is the
 *  filter - cluttered game-UI text matches no base name. */
export function detectBaseType(words: Word[]): string | null {
  const kept = words.filter((w) => w.confidence >= 40 && /[A-Za-z]/.test(w.text))
  const lines: Word[][] = []
  for (const w of [...kept].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)) {
    const line = lines.find((l) => Math.abs(l[0].bbox.y0 - w.bbox.y0) < 14)
    if (line) line.push(w)
    else lines.push([w])
  }
  let best: string | null = null
  let bestLen = 0
  for (const line of lines) {
    const toks = line
      .sort((a, b) => a.bbox.x0 - b.bbox.x0)
      .map((w) => w.text.toUpperCase().replace(/[^A-Z ]/g, '').trim())
      .filter(Boolean)
    for (let n = Math.min(3, toks.length); n >= 1; n--)
      for (let i = 0; i + n <= toks.length; i++) {
        const sub = toks.slice(i, i + n).join(' ')
        const orig = BASE_NAMES.get(sub)
        if (orig && n > bestLen) {
          best = orig
          bestLen = n
        }
      }
  }
  return best
}
