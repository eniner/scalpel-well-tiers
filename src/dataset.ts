import desecrated from './data/desecrated-poe2.json'
import itemTiers from './data/tiers-poe2.json'
import { normKey } from './normalize'

export interface Tier {
  min: number
  max: number
  lvl: number
}

type DesecratedData = { mods: { key: string; tiers: Tier[] }[] }
type ItemData = {
  mods: { l: number; s: [string, number, number][]; t: string }[]
  pools: Record<string, number[]>[]
  bases: Record<string, number>
}

const item = itemTiers as unknown as ItemData

/** Uppercased base-type name -> original-case name, for OCR base detection. */
export const BASE_NAMES: Map<string, string> = new Map(Object.keys(item.bases).map((b) => [b.toUpperCase(), b]))

function pushTier(map: Map<string, Tier[]>, key: string, t: Tier): void {
  const arr = map.get(key) ?? []
  if (!arr.some((x) => x.min === t.min && x.max === t.max)) arr.push(t)
  map.set(key, arr)
}

/** A single-stat mod -> its display-space tier (absolute, so negative "reduced" rolls match positive OCR). */
function tierFromMod(mod: ItemData['mods'][number]): Tier | null {
  if (mod.s.length !== 1) return null
  const [id, lo, hi] = mod.s[0]
  const d = id.endsWith('_permyriad') ? 100 : 1
  const a = Math.abs(lo / d)
  const b = Math.abs(hi / d)
  return { min: Math.min(a, b), max: Math.max(a, b), lvl: mod.l }
}

/**
 * Normalized-text -> ascending tier ladder. Always includes the global desecrated
 * pool. For the item-domain mods: when `baseType` resolves to a known base, only
 * that base's pool is used (correct per-base tiers); otherwise every base's ladder
 * is merged (the fallback - inflated counts, but never wrong about value-in-range).
 */
export function buildTierMap(baseType?: string | null): Map<string, Tier[]> {
  const map = new Map<string, Tier[]>()
  for (const mod of (desecrated as unknown as DesecratedData).mods) for (const t of mod.tiers) pushTier(map, mod.key, t)

  const poolIdx = baseType != null ? item.bases[baseType] : undefined
  if (poolIdx != null && item.pools[poolIdx]) {
    for (const idxList of Object.values(item.pools[poolIdx]))
      for (const i of idxList) {
        const t = tierFromMod(item.mods[i])
        if (t) pushTier(map, normKey(item.mods[i].t), t)
      }
  } else {
    for (const mod of item.mods) {
      const t = tierFromMod(mod)
      if (t) pushTier(map, normKey(mod.t), t)
    }
  }
  for (const arr of map.values()) arr.sort((a, b) => a.min - b.min)
  return map
}
