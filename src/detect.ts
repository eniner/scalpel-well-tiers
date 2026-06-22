import { BASE_NAMES } from './dataset'
import type { Box, Word } from './segment'

export interface BaseMatch {
  name: string
  box: Box
}

/** Levenshtein distance between a and b, early-exiting once the running minimum
 *  exceeds `max` (returns max+1). Length-difference shortcut keeps it cheap.
 *  Exported so the reward-price fuzzy matcher (rewards.ts) reuses it. */
export function lev(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    let rowMin = dp[0]
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1
      prev = tmp
      if (dp[j] < rowMin) rowMin = dp[j]
    }
    if (rowMin > max) return max + 1
  }
  return dp[b.length]
}

/** How many OCR character errors we tolerate when fuzzy-matching a base name of
 *  the given length. Tight enough that unrelated UI text won't collide. */
const fuzzBudget = (len: number): number => (len <= 8 ? 1 : 2)

/** Bounding box (frame px) enclosing a set of OCR words. */
function boxOf(ws: Word[]): Box {
  const x0 = Math.min(...ws.map((w) => w.bbox.x0))
  const y0 = Math.min(...ws.map((w) => w.bbox.y0))
  const x1 = Math.max(...ws.map((w) => w.bbox.x1))
  const y1 = Math.max(...ws.map((w) => w.bbox.y1))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Cluster OCR words into reading-order lines, keeping each token paired with
 *  its source word (so a matched window can report its on-screen box). Tokens are
 *  uppercased and stripped to letters; empty ones are dropped. */
function tokenLines(words: Word[]): { tok: string; w: Word }[][] {
  const kept = words.filter((w) => w.confidence >= 40 && /[A-Za-z]/.test(w.text))
  const lines: Word[][] = []
  for (const w of [...kept].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)) {
    const line = lines.find((l) => Math.abs(l[0].bbox.y0 - w.bbox.y0) < 14)
    if (line) line.push(w)
    else lines.push([w])
  }
  return lines.map((line) =>
    line
      .sort((a, b) => a.bbox.x0 - b.bbox.x0)
      .map((w) => ({ tok: w.text.toUpperCase().replace(/[^A-Z ]/g, '').trim(), w }))
      .filter((p) => p.tok.length > 0),
  )
}

interface Win {
  sub: string
  words: Word[]
}

/** Every 1..4-word window across all lines, with its joined token string + words. */
function windows(lines: { tok: string; w: Word }[][]): Win[] {
  const out: Win[] = []
  for (const line of lines)
    for (let n = Math.min(4, line.length); n >= 1; n--)
      for (let i = 0; i + n <= line.length; i++) {
        const slice = line.slice(i, i + n)
        out.push({ sub: slice.map((p) => p.tok).join(' '), words: slice.map((p) => p.w) })
      }
  return out
}

/** Find the item's base type in the OCR words by matching word-windows against
 *  the known base-type vocabulary. Tries exact matches first (longest wins), then
 *  a fuzzy pass tolerating a few OCR character errors. Returns the matched base
 *  name plus the on-screen box of the matched words (frame px), or null. */
export function detectBaseType(words: Word[]): BaseMatch | null {
  const wins = windows(tokenLines(words))

  let best: BaseMatch | null = null
  let bestLen = 0
  for (const win of wins) {
    const orig = BASE_NAMES.get(win.sub)
    const n = win.sub.split(' ').length
    if (orig && n > bestLen) {
      best = { name: orig, box: boxOf(win.words) }
      bestLen = n
    }
  }
  if (best) return best

  // Fuzzy fallback: only multi-word windows vs multi-word base keys (single
  // words are too collision-prone). Lowest distance wins; ties prefer the longer
  // name. Runs only when no exact match was found, so it never costs the hot path.
  let bestDist = Number.POSITIVE_INFINITY
  for (const win of wins) {
    if (win.sub.indexOf(' ') < 0) continue
    for (const [key, orig] of BASE_NAMES) {
      if (key.indexOf(' ') < 0) continue
      const budget = fuzzBudget(key.length)
      const d = lev(win.sub, key, budget)
      if (d <= budget && (d < bestDist || (d === bestDist && orig.length > (best?.name.length ?? 0)))) {
        bestDist = d
        best = { name: orig, box: boxOf(win.words) }
      }
    }
  }
  return best
}

/** Diagnostics only: the closest base name to anything the OCR read (any
 *  distance up to 6) plus its on-screen box, so the panel can show
 *  "nearest X (off by N)" and a debug box when detection fails. */
export function nearestBase(words: Word[]): { name: string; dist: number; box: Box } | null {
  let best: { name: string; dist: number; box: Box } | null = null
  let bestDist = 7
  for (const win of windows(tokenLines(words))) {
    if (win.sub.indexOf(' ') < 0) continue
    for (const [key, orig] of BASE_NAMES) {
      if (key.indexOf(' ') < 0) continue
      const d = lev(win.sub, key, bestDist)
      if (d < bestDist) {
        bestDist = d
        best = { name: orig, dist: d, box: boxOf(win.words) }
      }
    }
  }
  return best
}
