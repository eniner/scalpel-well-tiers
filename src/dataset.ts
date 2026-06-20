import desecrated from './data/desecrated-poe2.json'
import itemTiers from './data/tiers-poe2.json'
import { normKey } from './normalize'

export interface Tier {
  min: number
  max: number
  lvl: number
}

type DesecratedData = { mods: { key: string; tiers: Tier[] }[] }
type ItemData = { mods: { l: number; s: [string, number, number][]; t: string }[] }

/** Merge both bundled datasets into one normalized-text -> ascending tier ladder. */
export function buildTierMap(): Map<string, Tier[]> {
  const map = new Map<string, Tier[]>()
  const push = (key: string, t: Tier) => {
    const arr = map.get(key) ?? []
    if (!arr.some((x) => x.min === t.min && x.max === t.max)) arr.push(t)
    map.set(key, arr)
  }
  for (const mod of (desecrated as unknown as DesecratedData).mods)
    for (const t of mod.tiers) push(mod.key, t)
  for (const mod of (itemTiers as unknown as ItemData).mods) {
    if (mod.s.length !== 1) continue
    const [id, lo, hi] = mod.s[0]
    const d = id.endsWith('_permyriad') ? 100 : 1
    // "reduced"/"faster" mods store negative ranges but render as positive; match in absolute space.
    const a = Math.abs(lo / d)
    const b = Math.abs(hi / d)
    push(normKey(mod.t), { min: Math.min(a, b), max: Math.max(a, b), lvl: mod.l })
  }
  for (const arr of map.values()) arr.sort((a, b) => a.min - b.min)
  return map
}
