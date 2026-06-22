import type { Tier } from './dataset'
import { extractValue, normKey } from './normalize'
import type { Box, Line } from './segment'

export interface TierResult {
  rank: number
  count: number
  tier: Tier
  aboveTop: boolean
}
export interface OptionTier {
  box: Box
  result: TierResult
  key: string
  text: string
}

/** Highest tier whose min <= value; clamps to the lowest tier below the floor. Ascending input. */
export function valueToTier(tiers: Tier[], value: number): Tier {
  let chosen = tiers[0]
  for (const t of tiers) if (value >= t.min) chosen = t
  return chosen
}

/** Of several candidate ladders for one mod text, pick the one the value best fits:
 *  prefer a ladder whose range actually contains the value, then the more granular. */
export function pickLadder(ladders: Tier[][], value: number): Tier[] {
  let best = ladders[0]
  let bestScore = -1
  for (const l of ladders) {
    const inRange = value >= l[0].min && value <= l[l.length - 1].max ? 1 : 0
    const score = inRange * 1000 + l.length
    if (score > bestScore) {
      bestScore = score
      best = l
    }
  }
  return best
}

function toResult(tiers: Tier[], value: number): TierResult {
  const tier = valueToTier(tiers, value)
  const rank = tiers.indexOf(tier) + 1
  return { rank, count: tiers.length, tier, aboveTop: value > tiers[tiers.length - 1].max }
}

export function resolveTier(map: Map<string, Tier[][]>, text: string, value: number): TierResult | null {
  const ladders = map.get(normKey(text))
  if (!ladders || ladders.length === 0) return null
  return toResult(pickLadder(ladders, value), value)
}

// Drop decorative-border OCR junk (brackets, currency/symbol glyphs) flanking the
// real mod text before normalizing for the substring match.
function clean(text: string): string {
  return text.replace(/[^A-Za-z0-9 %+().,-]+/g, ' ')
}
function overlapsX(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x
}
function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

/**
 * Match OCR lines against the tier vocabulary. For each line carrying a value, find
 * the LONGEST known mod key that is a substring of the cleaned+normalized line, and
 * also of the line joined with its same-column wrap continuation; keep whichever is
 * longer. Then collapse fragments of the same mod. UI noise matches nothing.
 */
export function extractOptions(map: Map<string, Tier[][]>, lines: Line[]): OptionTier[] {
  const keys = [...map.keys()].sort((a, b) => b.length - a.length)
  const longestKey = (text: string): string | null => {
    const nk = normKey(clean(text))
    for (const k of keys) if (k.length >= 12 && nk.includes(k)) return k
    return null
  }
  const out: OptionTier[] = []
  for (let i = 0; i < lines.length; i++) {
    const value = extractValue(lines[i].text)
    if (value == null) continue
    let key = longestKey(lines[i].text)
    let box = lines[i].box
    let text = lines[i].text
    const below = lines.find(
      (l, j) =>
        j !== i &&
        l.box.y > lines[i].box.y &&
        l.box.y < lines[i].box.y + lines[i].box.h * 2.5 &&
        overlapsX(l.box, lines[i].box),
    )
    if (below) {
      const joined = longestKey(`${lines[i].text} ${below.text}`)
      if (joined && (!key || joined.length > key.length)) {
        key = joined
        box = unionBox(lines[i].box, below.box)
        text = `${lines[i].text} ${below.text}`
      }
    }
    if (!key) continue
    const ladders = map.get(key)
    if (!ladders) continue
    out.push({ box, key, text, result: toResult(pickLadder(ladders, value), value) })
  }
  const deduped: OptionTier[] = []
  for (const o of [...out].sort((a, b) => b.key.length - a.key.length)) {
    const dup = deduped.some(
      (k) =>
        overlapsX(k.box, o.box) &&
        Math.abs(k.box.y - o.box.y) < Math.max(k.box.h, o.box.h, 14) * 4 &&
        (k.key === o.key || k.key.includes(o.key) || o.key.includes(k.key)),
    )
    if (!dup) deduped.push(o)
  }
  return deduped.sort((a, b) => a.box.y - b.box.y)
}

/**
 * The well's "...reveal the Desecrated Modifier" hint line sits between the item's
 * existing mods (above) and the desecrated options (below). Return the Y below which
 * the options live, or null if the hint isn't found.
 */
export function findOptionsBoundary(lines: Line[]): number | null {
  let y: number | null = null
  for (const l of lines) {
    const t = l.text.toUpperCase()
    if (t.includes('DESECRATED') || t.includes('REVEA') || (t.includes('TAKE') && t.includes('ITEM'))) {
      const bottom = l.box.y + l.box.h
      if (y == null || bottom > y) y = bottom
    }
  }
  return y
}
