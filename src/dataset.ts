import baseIcons from './data/base-icons-poe2.json'
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
  mods: { l: number; g: string; s: [string, number, number][]; t: string }[]
  pools: Record<string, number[]>[]
  bases: Record<string, number>
}

const item = itemTiers as unknown as ItemData

/** Uppercased base-type name -> original-case name, for OCR base detection. */
export const BASE_NAMES: Map<string, string> = new Map(Object.keys(item.bases).map((b) => [b.toUpperCase(), b]))

/** Base-type name -> CDN art URL (PoE2 base-item subset of Scalpel's icon map),
 *  for the hero image. Null when the base has no bundled icon. */
export const baseIconUrl = (name: string): string | null => (baseIcons as Record<string, string>)[name] ?? null

/** Raw stat -> displayed value divisor (RePoE stores some stats in internal units). */
function divisor(id: string): number {
  if (id.endsWith('_permyriad')) return 100 // per-10,000 -> %
  if (id.endsWith('_per_minute')) return 60 // e.g. life regen stored /min, shown /sec
  return 1
}

/** A single-stat mod -> its display-space tier (absolute, so negative "reduced" rolls match positive OCR). */
function tierFromMod(mod: ItemData['mods'][number]): Tier | null {
  if (mod.s.length !== 1) return null
  const [id, lo, hi] = mod.s[0]
  const d = divisor(id)
  const a = Math.abs(lo / d)
  const b = Math.abs(hi / d)
  return { min: Math.min(a, b), max: Math.max(a, b), lvl: mod.l }
}

/**
 * Normalized-text -> candidate tier ladders. A mod's text can map to several
 * distinct ladders (a prefix and a suffix variant, the desecrated pool, ...);
 * those must NOT be merged (that inflates the tier count). Each ladder is one
 * mod-group's tiers, ascending. The matcher picks the best-fitting ladder for the
 * rolled value. Item ladders are scoped to `baseType` when it resolves to a base;
 * otherwise every base's ladders are included (inflated, but never out of range).
 */
export function buildTierMap(baseType?: string | null): Map<string, Tier[][]> {
  const byKeyGroup = new Map<string, Map<string, Tier[]>>()
  const add = (key: string, group: string, t: Tier) => {
    let g = byKeyGroup.get(key)
    if (!g) {
      g = new Map()
      byKeyGroup.set(key, g)
    }
    let arr = g.get(group)
    if (!arr) {
      arr = []
      g.set(group, arr)
    }
    if (!arr.some((x) => x.min === t.min && x.max === t.max)) arr.push(t)
  }

  for (const mod of (desecrated as unknown as DesecratedData).mods) for (const t of mod.tiers) add(mod.key, `desec:${mod.key}`, t)

  const poolIdx = baseType != null ? item.bases[baseType] : undefined
  if (poolIdx != null && item.pools[poolIdx]) {
    for (const [group, idxList] of Object.entries(item.pools[poolIdx]))
      for (const i of idxList) {
        const t = tierFromMod(item.mods[i])
        if (t) add(normKey(item.mods[i].t), group, t)
      }
  } else {
    for (const mod of item.mods) {
      const t = tierFromMod(mod)
      if (t) add(normKey(mod.t), mod.g || '?', t)
    }
  }

  const map = new Map<string, Tier[][]>()
  for (const [key, g] of byKeyGroup) {
    const ladders = [...g.values()].map((arr) => [...arr].sort((a, b) => a.min - b.min)).filter((l) => l.length)
    if (ladders.length) map.set(key, ladders)
  }
  return map
}
