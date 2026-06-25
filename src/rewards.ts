import { lev } from './detect'
import { isKnownRewardName, matchCanonicalRewardNameStrict } from './rewards-catalog'
import type { Box, Line } from './segment'

/** A candidate reward line off the Runeshape Combinations panel. The leading
 *  count ("Nx") is small and often dropped by OCR, so it's optional: `qty`
 *  defaults to 1 and `explicit` records whether the prefix was actually read. */
export interface Candidate {
  qty: number
  name: string
  box: Box
  explicit: boolean
}

/** A reward with its poe.ninja valuation resolved. `text` is the display string
 *  ("3 ex", "1.4 div", or "?"); `value` is the stack's exalted value (for
 *  ranking the best reward), null when unpriced. `name` is the matched canonical
 *  name when found, otherwise the raw OCR name. */
export interface PricedReward {
  qty: number
  name: string
  box: Box
  text: string
  value: number | null
}

/** Just the price fields rewards.ts needs from a host PriceEntry. Kept local and
 *  structural so this module has no SDK dependency and stays unit-testable. */
export interface PriceLike {
  name: string
  chaosValue: number
  divineValue?: number
}

const HEADER_RE = /^runeshape/i
const QTY_TOKEN = /(\d+)\s*[%xX]\s*/g
const ONLY_QTY_RE = /^(\d+)\s*[%xX]\s*$/
const INCOMPLETE_ORB_RE = /^(\d+)\s*[%xX]\s+Orb of\s*$/i
const LOOSE_QTY_RE = /^(\d+)\s+(?!x\b)(.+)$/i
const MERGE_Y_GAP = 58
const CANDIDATE_Y_DEDUPE = 48

/** Fix systematic Runeshape OCR slips before line merge / candidate parse. */
export function sanitizeOcrRewardLine(text: string): string {
  let s = text.replace(/\s+/g, ' ').trim()
  s = s.replace(/(\d+)\s*%\s*of\b/gi, '$1x Orb of')
  s = s.replace(/(\d+)\s*%\s+/g, '$1x ')
  s = s.replace(/^(?:(?:st|pri|a|her|ng|i)\s+)+/gi, '')
  s = s.replace(/^(\d+)\s+(\d+\s*[%xX]\s*)/, '$2')
  s = s.replace(/\b(\d+\s*[%xX]\s+)of\s+(transmutation|augmentation|alchemy|chance)\b/gi, '$1Orb of $2')
  if (!/\borb\s+of\s+(transmutation|augmentation|alchemy|chance)\b/i.test(s)) {
    s = s.replace(/\bof\s+(transmutation|augmentation|alchemy|chance)\b/gi, 'Orb of $1')
  }
  return s.trim()
}

/** Merge a lone "2x" OCR row into the next reward-shaped line below (common on the
 *  top rows where the item name lands on the following line or is truncated). */
export function mergeFragmentedOcrLines(lines: Line[]): Line[] {
  const sorted = [...lines].sort((a, b) => a.box.y - b.box.y)
  const skip = new Set<number>()
  const drop = new Set<number>()
  const out: Line[] = []

  const mergedBox = (a: Line, b: Line): Box => ({
    x: Math.min(a.box.x, b.box.x),
    y: a.box.y,
    w: Math.max(a.box.x + a.box.w, b.box.x + b.box.w) - Math.min(a.box.x, b.box.x),
    h: b.box.y + b.box.h - a.box.y,
  })

  for (let i = 0; i < sorted.length; i++) {
    if (skip.has(i) || drop.has(i)) continue
    const cur = sorted[i]
    const raw = sanitizeOcrRewardLine(cur.text)
    if (!raw) continue

    if (ONLY_QTY_RE.test(raw)) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].box.y - cur.box.y > MERGE_Y_GAP) break
        const nextRaw = sanitizeOcrRewardLine(sorted[j].text)
        if (/^\d+\s*[%xX]\s+\S/.test(nextRaw)) {
          drop.add(i)
          break
        }
      }
      if (drop.has(i)) continue

      let merged: Line | null = null
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].box.y - cur.box.y > MERGE_Y_GAP) break
        const nextRaw = sanitizeOcrRewardLine(sorted[j].text)
        if (!nextRaw || HEADER_RE.test(nextRaw)) continue
        if (ONLY_QTY_RE.test(nextRaw)) continue
        if (nextRaw.length < 4 && !looksLikeReward(nextRaw)) continue
        if (/^\d+\s*[%xX]/.test(nextRaw)) break
        merged = { text: `${raw} ${nextRaw}`, box: mergedBox(cur, sorted[j]) }
        skip.add(j)
        break
      }
      if (merged) {
        out.push(merged)
        continue
      }
    }

    // "2x Orb of" on one row, "Augmentation" (or a short tail) on the next.
    if (INCOMPLETE_ORB_RE.test(raw)) {
      let merged: Line | null = null
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].box.y - cur.box.y > MERGE_Y_GAP) break
        const nextRaw = sanitizeOcrRewardLine(sorted[j].text)
        if (!nextRaw || HEADER_RE.test(nextRaw)) continue
        if (/^\d+\s*[%xX]/.test(nextRaw)) break
        merged = { text: `${raw}${nextRaw}`, box: mergedBox(cur, sorted[j]) }
        skip.add(j)
        break
      }
      if (merged) {
        out.push(merged)
        continue
      }
    }

    // Lone "1x Greater" / "1x Lesser" — name continues on the next row when the
    // Jeweller's Orb suffix lands below the prefix.
    if (/^\d+\s*[%xX]\s+(?:Greater|Lesser)\s*$/i.test(raw)) {
      let merged: Line | null = null
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].box.y - cur.box.y > MERGE_Y_GAP) break
        const nextRaw = sanitizeOcrRewardLine(sorted[j].text)
        if (!nextRaw || HEADER_RE.test(nextRaw)) continue
        if (/^\d+\s*[%xX]/.test(nextRaw)) break
        if (/\bjewell/i.test(nextRaw) || /\borb\b/i.test(nextRaw)) {
          merged = { text: `${raw} ${nextRaw}`, box: mergedBox(cur, sorted[j]) }
          skip.add(j)
          break
        }
      }
      if (merged) {
        out.push(merged)
        continue
      }
    }

    out.push({ text: raw, box: cur.box })
  }
  return out
}

/** Strip trailing rune-icon OCR junk and stray digits from a reward name. */
export function cleanOcrRewardName(name: string): string {
  let s = name.replace(/\s+/g, ' ').trim()
  s = s.replace(/\s+(?:NG|XX|KX|OX|RX|NX)$/i, '').trim()
  s = s.replace(/[\\/|]+$/g, '').trim()
  s = s.replace(/\s+\d{3,}$/, '').trim()
  s = s.replace(/\s+\d{1,2}$/, '').trim()
  s = s.replace(/\s+[A-Za-z]$/i, '').trim()
  return s
}

/** Expand common Runeshape truncations before catalog + price lookup. */
export function expandTruncatedRewardName(name: string): string {
  const n = norm(name)
  if (n === 'prism' || n.endsWith(' prism') || (/\bprism\b/.test(n) && !n.includes('gemcutter'))) {
    return "Gemcutter's Prism"
  }
  if (n === 'bauble' || n.endsWith(' bauble') || n === 'buble' || n.endsWith(' buuble')) return "Glassblower's Bauble"
  if (n === 'greater orb' || (n.startsWith('greater ') && /\borb\b/.test(n) && !n.includes('jewell'))) {
    return "Greater Jeweller's Orb"
  }
  if (n === 'lesser orb' || (n.startsWith('lesser ') && /\borb\b/.test(n) && !n.includes('jewell'))) {
    return "Lesser Jeweller's Orb"
  }
  if (n === 'greater') return "Greater Jeweller's Orb"
  if (/^greater\b/.test(n) && /\bjewell/.test(n)) return "Greater Jeweller's Orb"
  if (/^lesser\b/.test(n) && /\bjewell/.test(n)) return "Lesser Jeweller's Orb"
  if (/^lesser\b/.test(n) && !n.includes('jewell') && !/\borb\b/.test(n)) return "Lesser Jeweller's Orb"
  const canonical = matchCanonicalRewardNameStrict(name)
  if (canonical) return canonical
  if (/\btransmutation$/.test(n)) return 'Orb of Transmutation'
  if (/\baugmentation$/.test(n)) return 'Orb of Augmentation'
  return name
}

function canonicalizeRewardName(name: string): string {
  return expandTruncatedRewardName(name)
}

/** Split one OCR line into every embedded "Nx <name>" segment (handles merged rows). */
export function extractRewardSegments(text: string): Array<{ qty: number; name: string }> {
  const hits: Array<{ qty: number; nameStart: number; nextStart: number }> = []
  for (const m of text.matchAll(QTY_TOKEN)) {
    const idx = m.index ?? 0
    hits.push({
      qty: Number(m[1]),
      nameStart: idx + m[0].length,
      nextStart: idx,
    })
  }
  if (hits.length === 0) return []
  const out: Array<{ qty: number; name: string }> = []
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].nextStart : text.length
    const name = cleanOcrRewardName(text.slice(hits[i].nameStart, end))
    if (!name) continue
    let qty = hits[i].qty
    if (!Number.isFinite(qty) || qty <= 0) qty = 1
    out.push({ qty, name })
  }
  return out
}

export function parseRewardCandidates(lines: Line[]): Candidate[] {
  const out: Candidate[] = []
  for (const l of lines) {
    const raw = sanitizeOcrRewardLine(l.text)
    if (!raw || HEADER_RE.test(raw) || /^poe\.ninja/i.test(raw)) continue

    const segments = extractRewardSegments(raw)
    if (segments.length > 0) {
      for (const seg of segments) {
        if (seg.name.length < 4 || !/[a-z]/i.test(seg.name)) continue
        out.push({ qty: seg.qty, name: seg.name, box: l.box, explicit: true })
      }
      continue
    }

    const loose = raw.match(LOOSE_QTY_RE)
    if (loose) {
      const qty = Number(loose[1])
      const name = cleanOcrRewardName(loose[2])
      if (name.length >= 4 && /[a-z]/i.test(name) && looksLikeReward(name)) {
        out.push({ qty: Number.isFinite(qty) && qty > 0 ? qty : 1, name, box: l.box, explicit: true })
        continue
      }
    }

    const name = cleanOcrRewardName(raw)
    if (name.length < 4 || !/[a-z]/i.test(name)) continue
    out.push({ qty: 1, name, box: l.box, explicit: false })
  }
  return dedupeCandidates(out)
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const out: Candidate[] = []
  for (const c of candidates) {
    const cKey = norm(canonicalizeRewardName(c.name))
    const dupIdx = out.findIndex(
      (o) =>
        Math.abs(o.box.y - c.box.y) < CANDIDATE_Y_DEDUPE &&
        o.qty === c.qty &&
        norm(canonicalizeRewardName(o.name)) === cKey,
    )
    if (dupIdx >= 0) {
      const dup = out[dupIdx]
      const keep = c.name.length > dup.name.length || (c.explicit && !dup.explicit) ? c : dup
      out[dupIdx] = keep
      continue
    }
    out.push(c)
  }
  return out
}

/** Normalize an item name for matching: lowercase, punctuation to spaces,
 *  collapse whitespace. Stable across the OCR's stray apostrophes/commas. */
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

/** Normalized name -> the price entries sharing it. A list (not a single entry)
 *  so genuine variant ambiguity (e.g. one name priced at several levels) can be
 *  detected and refused rather than guessed. */
export type PriceIndex = Map<string, PriceLike[]>

/** Collapse duplicate poe.ninja rows (e.g. all+currency merged twice). When values
 *  disagree, keep the median so a row still prices instead of showing "?". */
export function dedupePriceEntries(entries: PriceLike[]): PriceLike[] {
  const byKey = new Map<string, PriceLike[]>()
  for (const e of entries) {
    const k = norm(e.name)
    if (!k) continue
    const list = byKey.get(k)
    if (list) list.push(e)
    else byKey.set(k, [e])
  }
  const out: PriceLike[] = []
  for (const list of byKey.values()) {
    const v0 = list[0].chaosValue
    if (list.length === 1 || list.every((e) => e.chaosValue === v0)) {
      out.push(list[0])
      continue
    }
    out.push(...list)
  }
  return out
}

export function buildPriceIndex(entries: PriceLike[]): PriceIndex {
  const idx: PriceIndex = new Map()
  for (const e of dedupePriceEntries(entries)) {
    const k = norm(e.name)
    if (!k) continue
    const list = idx.get(k)
    if (list) list.push(e)
    else idx.set(k, [e])
  }
  return idx
}

/** Unique fuzzy match within a tight edit budget, for OCR slips ("Transmutaton").
 *  Returns null when zero or more than one key ties, so noise never prices. */
function fuzzy(index: PriceIndex, key: string): PriceLike[] | null {
  if (key.length < 6) return null
  const budget = key.length <= 12 ? 1 : 2
  let best: PriceLike[] | null = null
  let bestDist = budget + 1
  let tie = false
  for (const [k, list] of index) {
    const d = lev(key, k, bestDist)
    if (d < bestDist) {
      bestDist = d
      best = list
      tie = false
    } else if (d === bestDist) {
      tie = true
    }
  }
  return tie ? null : best
}

const PARTIAL_SUFFIX_HINT: Record<string, string> = {
  prism: 'gemcutter',
  bauble: 'glassblower',
  buuble: 'glassblower',
}

/** When OCR truncates to a tail fragment ("Bauble", "Lesser Orb"), match only if
 *  the token set identifies a single poe.ninja row. Refuses bare "orb"/"gem". */
function resolvePartial(index: PriceIndex, n: string): PriceLike[] | null {
  const tokens = n.split(' ').filter((t) => t.length >= 3)
  if (tokens.length === 0) return null
  if (tokens.length === 1 && (tokens[0] === 'orb' || tokens[0] === 'gem')) return null

  const hits: PriceLike[] = []
  for (const [k, list] of index) {
    if (tokens.every((t) => k.includes(t))) hits.push(...list)
  }
  if (hits.length === 0) return null

  const byName = new Map<string, PriceLike>()
  for (const e of hits) byName.set(e.name, e)
  let unique = [...byName.values()]

  if (tokens.length === 1) {
    const t = tokens[0]
    unique = unique.filter((e) => {
      const kn = norm(e.name)
      return new RegExp(`\\b${t}\\b`).test(kn)
    })
    if (unique.length > 1) {
      const ends = unique.filter((e) => norm(e.name).endsWith(` ${t}`))
      if (ends.length === 1) unique = ends
      else if (ends.length > 1) {
        const hint = PARTIAL_SUFFIX_HINT[t]
        if (hint) {
          const hinted = ends.filter((e) => norm(e.name).includes(hint))
          if (hinted.length === 1) unique = hinted
        }
      }
    }
  }
  if (unique.length !== 1) return null

  const v0 = unique[0].chaosValue
  const same = hits.filter((e) => e.name === unique[0].name)
  if (same.length > 1 && same.some((e) => e.chaosValue !== v0)) return null
  return same
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** When the game shows "Uncut Spirit Gem" without a level, average poe.ninja's
 *  per-level rows so we can still show a useful estimate. */
function resolveUncutFamily(index: PriceIndex, n: string): PriceLike | null {
  const m = n.match(/^uncut (spirit|skill|support|gold)(?: gem)?$/)
  if (!m) return null
  const kind = m[1] === 'gold' ? 'spirit' : m[1]
  const family = `uncut ${kind} gem`
  const bucket: PriceLike[] = []
  for (const [k, list] of index) {
    if (k === family || k.startsWith(`${family} level`)) bucket.push(...list)
  }
  if (bucket.length === 0) return null
  const chaosValue = median(bucket.map((e) => e.chaosValue))
  const divs = bucket.map((e) => e.divineValue).filter((d): d is number => d != null)
  const divineValue = divs.length > 0 ? median(divs) : undefined
  const display = bucket[0].name.replace(/\s*\(level \d+\)/i, '')
  return { name: display, chaosValue, divineValue }
}

/** The price entry for a reward name, or null when unknown or ambiguous. */
function resolve(index: PriceIndex, name: string): PriceLike | null {
  const expanded = canonicalizeRewardName(name)
  const n = norm(expanded)
  const uncut = resolveUncutFamily(index, n)
  if (uncut) return uncut
  const list = index.get(n) ?? fuzzy(index, n) ?? resolvePartial(index, n)
  if (!list || list.length === 0) return null
  const v0 = list[0].chaosValue
  if (list.length > 1 && list.some((e) => e.chaosValue !== v0)) return null
  return list[0]
}

/** When OCR splits "2x Orb of" from its suffix, infer the remaining orb name from
 *  siblings on the same panel (e.g. Transmutation already read -> Augmentation). */
function completeOrbOfFragments(candidates: Candidate[], index: PriceIndex): Candidate[] {
  const taken = new Set(
    candidates
      .map((c) => norm(canonicalizeRewardName(c.name)))
      .filter((n) => n.startsWith('orb of ') && n !== 'orb of'),
  )
  for (const c of candidates) {
    const n = norm(c.name)
    if (n.includes('transmutation')) taken.add('orb of transmutation')
    if (n.includes('augmentation')) taken.add('orb of augmentation')
  }

  return candidates.map((c) => {
    const n = norm(c.name)
    if (n !== 'orb of') return c

    const pool = [...index.keys()].filter((k) => k.startsWith('orb of ') && k.length > 7)
    const unused = pool.filter((k) => !taken.has(k))
    if (unused.length === 1) {
      const hit = index.get(unused[0])?.[0]
      if (hit) return { ...c, name: hit.name }
    }
    if (unused.includes('orb of augmentation') && taken.has('orb of transmutation')) {
      return { ...c, name: 'Orb of Augmentation' }
    }
    if (unused.includes('orb of transmutation') && taken.has('orb of augmentation')) {
      return { ...c, name: 'Orb of Transmutation' }
    }
    return c
  })
}

/** Heuristic for reward-shaped names when OCR drops the "Nx" prefix. */
function looksLikeReward(name: string): boolean {
  if (isKnownRewardName(name)) return true
  const n = norm(name)
  if (n.startsWith('uncut ')) return true
  if (/\bwarding\b/.test(n) || /\brune\b/.test(n)) return true
  return /\b(orb|gem|prism|bauble|shard|jewell|infuser|essence|dust|tablet|key)\b/.test(n)
}

/** Why a name did or didn't match the price index (for on-screen debug). */
export function explainPriceLookup(index: PriceIndex, name: string): string {
  const expanded = canonicalizeRewardName(name)
  const n = norm(expanded)
  const prefix =
    expanded !== name
      ? `canonical "${name}" -> ${expanded}; `
      : ''
  const uncut = resolveUncutFamily(index, n)
  if (uncut) return `${prefix}uncut median -> ${uncut.name}`
  const exact = index.get(n)
  if (exact) {
    const v0 = exact[0].chaosValue
    if (exact.length > 1 && exact.some((e) => e.chaosValue !== v0)) {
      return `${prefix}ambiguous exact (${exact.length} rows, differing values)`
    }
    return `${prefix}exact -> ${exact[0].name}`
  }
  const fuzz = fuzzy(index, n)
  if (fuzz) {
    const v0 = fuzz[0].chaosValue
    if (fuzz.length > 1 && fuzz.some((e) => e.chaosValue !== v0)) {
      return `${prefix}ambiguous fuzzy (${fuzz.length} rows, differing values)`
    }
    return `${prefix}fuzzy -> ${fuzz[0].name}`
  }
  const partial = resolvePartial(index, n)
  if (partial) return `${prefix}partial -> ${partial[0].name}`
  return `${prefix}no match (norm="${n}")`
}

export interface CandidateDiagnosis {
  qty: number
  name: string
  explicit: boolean
  y: number
  outcome: 'priced' | 'unpriced' | 'dropped'
  detail: string
  badge: string | null
}

export function diagnoseCandidates(candidates: Candidate[], index: PriceIndex): CandidateDiagnosis[] {
  const ready = completeOrbOfFragments(candidates, index)
  return ready.map((c) => {
    const y = Math.round(c.box.y)
    const entry = resolve(index, c.name)
    if (entry) {
      const [priced] = priceRewards([c], index)
      return {
        qty: c.qty,
        name: c.name,
        explicit: c.explicit,
        y,
        outcome: 'priced',
        detail: explainPriceLookup(index, c.name),
        badge: priced?.text ?? null,
      }
    }
    if (c.explicit || looksLikeReward(c.name)) {
      const why = c.explicit ? 'explicit Nx' : 'looksLikeReward'
      return {
        qty: c.qty,
        name: c.name,
        explicit: c.explicit,
        y,
        outcome: 'unpriced',
        detail: `${why}; ${explainPriceLookup(index, c.name)}`,
        badge: '?',
      }
    }
    return {
      qty: c.qty,
      name: c.name,
      explicit: c.explicit,
      y,
      outcome: 'dropped',
      detail: `hidden; ${explainPriceLookup(index, c.name)}`,
      badge: null,
    }
  })
}

/** Scalpel's price number formatting, inlined so this module needs no SDK
 *  runtime import (mirrors @scalpelpoe/plugin-sdk formatPrice). */
export function fmtNum(value: number): string {
  if (value >= 1000) return `${Number.parseFloat((value / 1000).toFixed(1))}k`
  if (value >= 10) return String(Math.round(value))
  if (value >= 1) return String(Number.parseFloat(value.toFixed(1)))
  return String(Number.parseFloat(value.toFixed(2)))
}

/** Value each candidate, and in doing so filter candidates down to actual
 *  rewards: a line that resolves to a real price is a reward; a line with an
 *  explicit "Nx" prefix is kept even unpriced (strong reward signal -> "?"). */
export function priceRewards(candidates: Candidate[], index: PriceIndex): PricedReward[] {
  const ready = completeOrbOfFragments(candidates, index)
  const out: PricedReward[] = []
  for (const c of ready) {
    const entry = resolve(index, c.name)
    if (!entry) {
      if (c.explicit || looksLikeReward(c.name)) {
        out.push({ qty: c.qty, name: c.name, box: c.box, text: '?', value: null })
      }
      continue
    }
    const totalEx = entry.chaosValue * c.qty
    const totalDiv = entry.divineValue != null ? entry.divineValue * c.qty : null
    const text = totalDiv != null && totalDiv >= 1 ? `${fmtNum(totalDiv)} div` : `${fmtNum(totalEx)} ex`
    out.push({ qty: c.qty, name: entry.name, box: c.box, text, value: totalEx })
  }
  return out
}
