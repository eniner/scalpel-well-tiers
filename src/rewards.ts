import { lev } from './detect'
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

// The "Nx" count, found ANYWHERE in the line (not anchored to the start): the
// rune-shape icons left of a row often OCR as garbage glyphs prepended to it
// (e.g. "NG 1x Orb of Transmutation"), so we locate the count token and take the
// name from after it. When no count is present at all the whole line is the
// name (qty 1); the price lookup is what then filters real rewards from the
// header / FPS noise.
const QTY_RE = /(\d+)\s*[xX]\s*(.+)$/

export function parseRewardCandidates(lines: Line[]): Candidate[] {
  const out: Candidate[] = []
  for (const l of lines) {
    const m = l.text.match(QTY_RE)
    const explicit = !!m
    let qty = m ? Number(m[1]) : 1
    if (!Number.isFinite(qty) || qty <= 0) qty = 1
    const name = (m ? m[2] : l.text).replace(/\s+/g, ' ').trim()
    // Drop pure-number / too-short fragments (FPS counter, stray digits) before
    // they reach the price lookup.
    if (name.length < 4 || !/[a-z]/i.test(name)) continue
    out.push({ qty, name, box: l.box, explicit })
  }
  return out
}

/** Normalize an item name for matching: lowercase, punctuation to spaces,
 *  collapse whitespace. Stable across the OCR's stray apostrophes/commas. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Normalized name -> the price entries sharing it. A list (not a single entry)
 *  so genuine variant ambiguity (e.g. one name priced at several levels) can be
 *  detected and refused rather than guessed. */
export type PriceIndex = Map<string, PriceLike[]>

export function buildPriceIndex(entries: PriceLike[]): PriceIndex {
  const idx: PriceIndex = new Map()
  for (const e of entries) {
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

/** The price entry for a reward name, or null when unknown or ambiguous. A name
 *  that maps to variant rows with differing values (e.g. an uncut gem priced per
 *  level, whose level we can't read) is treated as ambiguous - we render "?"
 *  rather than a wrong number. */
function resolve(index: PriceIndex, name: string): PriceLike | null {
  const list = index.get(norm(name)) ?? fuzzy(index, norm(name))
  if (!list || list.length === 0) return null
  const v0 = list[0].chaosValue
  if (list.length > 1 && list.some((e) => e.chaosValue !== v0)) return null
  return list[0]
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
 *  rewards: a line that resolves to a real price is a reward (the price list is
 *  the filter, so the panel header / OCR noise drop out); a line with an
 *  explicit "Nx" prefix is kept even unpriced (strong reward signal -> "?").
 *  In PoE2 chaosValue is the Exalted value; promote a stack to divine once it
 *  clears one divine. */
export function priceRewards(candidates: Candidate[], index: PriceIndex): PricedReward[] {
  const out: PricedReward[] = []
  for (const c of candidates) {
    const entry = resolve(index, c.name)
    if (!entry) {
      if (c.explicit) out.push({ qty: c.qty, name: c.name, box: c.box, text: '?', value: null })
      continue
    }
    const totalEx = entry.chaosValue * c.qty
    const totalDiv = entry.divineValue != null ? entry.divineValue * c.qty : null
    const text = totalDiv != null && totalDiv >= 1 ? `${fmtNum(totalDiv)} div` : `${fmtNum(totalEx)} ex`
    out.push({ qty: c.qty, name: entry.name, box: c.box, text, value: totalEx })
  }
  return out
}
