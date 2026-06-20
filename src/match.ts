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
}

/** Highest tier whose min <= value; clamps to the lowest tier below the floor. Ascending input. */
export function valueToTier(tiers: Tier[], value: number): Tier {
  let chosen = tiers[0]
  for (const t of tiers) if (value >= t.min) chosen = t
  return chosen
}

export function resolveTier(map: Map<string, Tier[]>, text: string, value: number): TierResult | null {
  const tiers = map.get(normKey(text))
  if (!tiers || tiers.length === 0) return null
  const tier = valueToTier(tiers, value)
  const rank = tiers.indexOf(tier) + 1
  return { rank, count: tiers.length, tier, aboveTop: value > tiers[tiers.length - 1].max }
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
 * Find option mod-lines among OCR lines. A line is an option if its text resolves
 * to a tier; if it doesn't but carries a number, try joining its same-column wrap
 * continuation (the line directly below, x-overlapping) and resolve that. Matching
 * against the known mod vocabulary is the filter - UI noise resolves to nothing.
 */
export function extractOptions(map: Map<string, Tier[]>, lines: Line[]): OptionTier[] {
  const out: OptionTier[] = []
  for (let i = 0; i < lines.length; i++) {
    const value = extractValue(lines[i].text)
    if (value == null) continue
    let result = resolveTier(map, lines[i].text, value)
    let box = lines[i].box
    if (!result) {
      const below = lines.find(
        (l, j) =>
          j !== i &&
          l.box.y > lines[i].box.y &&
          l.box.y < lines[i].box.y + lines[i].box.h * 2.5 &&
          overlapsX(l.box, lines[i].box),
      )
      if (below) {
        const joined = resolveTier(map, `${lines[i].text} ${below.text}`, value)
        if (joined) {
          result = joined
          box = unionBox(lines[i].box, below.box)
        }
      }
    }
    if (result) out.push({ box, result })
  }
  return out
}
