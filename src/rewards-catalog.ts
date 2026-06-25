import { lev } from './detect'
import catalog from './data/runeshape-rewards.json'

const CANONICAL: readonly string[] = catalog.names

function norm(s: string): string {
  let t = s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  t = t
    .replace(/\bgemcutters\b/g, 'gemcutter s')
    .replace(/\bglassblowers\b/g, 'glassblower s')
    .replace(/\bjewellers\b/g, 'jeweller s')
    .replace(/\barmourers\b/g, 'armourer s')
    .replace(/\bartificers\b/g, 'artificer s')
    .replace(/\barchitects\b/g, 'architect s')
    .replace(/\bblacksmiths\b/g, 'blacksmith s')
  return t
}

const NORM_TO_CANONICAL = new Map<string, string>()
for (const name of CANONICAL) {
  const k = norm(name)
  if (!NORM_TO_CANONICAL.has(k)) NORM_TO_CANONICAL.set(k, name)
}

function resolvePrefixHits(n: string): string | null {
  const truncated = CANONICAL.filter((c) => norm(c).startsWith(n))
  if (truncated.length === 1) return truncated[0]

  const embedded = CANONICAL.filter((c) => n.startsWith(norm(c)))
  if (embedded.length === 1) return embedded[0]
  if (embedded.length > 1) {
    embedded.sort((a, b) => norm(b).length - norm(a).length)
    if (norm(embedded[0]).length > norm(embedded[1]).length) return embedded[0]
  }
  return null
}

/** Strict catalog match for price lookup — exact, prefix, and warding only. */
export function matchCanonicalRewardNameStrict(name: string): string | null {
  const n = norm(name)
  if (!n || n.length < 3) return null

  const exact = NORM_TO_CANONICAL.get(n)
  if (exact) return exact

  const prefix = resolvePrefixHits(n)
  if (prefix) return prefix

  if (n.startsWith('warding rune of ')) {
    const suffix = n.slice('warding rune of '.length)
    const warding = CANONICAL.filter((c) => c.startsWith('Warding Rune of '))
    const hits = warding.filter((c) => {
      const tail = norm(c).slice('warding rune of '.length)
      return tail.startsWith(suffix) || suffix.startsWith(tail) || lev(suffix, tail, 3) <= 2
    })
    if (hits.length === 1) return hits[0]
  }

  return null
}

/** True when the OCR name matches a known Runeshape reward from the game catalog. */
export function isKnownRewardName(name: string): boolean {
  return matchCanonicalRewardName(name) != null
}

/** Map OCR text to the canonical game item name (RePoE + poe.ninja slug list). */
export function matchCanonicalRewardName(name: string): string | null {
  const strict = matchCanonicalRewardNameStrict(name)
  if (strict) return strict

  const n = norm(name)
  const budget = n.length <= 12 ? 2 : n.length <= 20 ? 3 : 4
  if (n.length < 5) return null
  let best: string | null = null
  let bestDist = budget + 1
  let tie = false
  for (const c of CANONICAL) {
    const d = lev(n, norm(c), bestDist)
    if (d < bestDist) {
      bestDist = d
      best = c
      tie = false
    } else if (d === bestDist) {
      tie = true
    }
  }
  return tie ? null : best
}

export function canonicalRewardCount(): number {
  return CANONICAL.length
}
