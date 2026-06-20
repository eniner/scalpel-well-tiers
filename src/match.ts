import type { Tier } from './dataset'
import { normKey } from './normalize'

export interface TierResult {
  rank: number
  count: number
  tier: Tier
  aboveTop: boolean
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
