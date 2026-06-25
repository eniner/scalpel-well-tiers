import { cleanOcrRewardName, expandTruncatedRewardName, extractRewardSegments, sanitizeOcrRewardLine } from './rewards'
import { matchCanonicalRewardName } from './rewards-catalog'

/** Runeshape row reader revision (mirrors runeshape-checker plugin). */
export const RUNESHAPE_READER_VERSION = '2.4.1'

const LOOSE_QTY_RE = /^(\d+)\s+(?!x\b)(.+)$/i

export interface DecodedRow {
  qty: number
  name: string
  explicit: boolean
  raw: string
}

function resolveName(name: string): string {
  const expanded = expandTruncatedRewardName(name)
  return matchCanonicalRewardName(expanded) ?? matchCanonicalRewardName(name) ?? expanded
}

/** Turn one row's noisy read into a catalog name when possible. */
export function decodeRowText(raw: string): DecodedRow | null {
  const text = sanitizeOcrRewardLine(raw)
  if (!text || text.length < 3) return null

  const segments = extractRewardSegments(text)
  if (segments.length > 0) {
    const seg = segments[0]!
    return {
      qty: seg.qty,
      name: resolveName(seg.name),
      explicit: true,
      raw: text,
    }
  }

  const loose = text.match(LOOSE_QTY_RE)
  if (loose) {
    const qty = Number(loose[1])
    const cleaned = cleanOcrRewardName(loose[2]!)
    const resolved = resolveName(cleaned)
    if (matchCanonicalRewardName(resolved) || cleaned.length >= 4) {
      return {
        qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
        name: resolved,
        explicit: true,
        raw: text,
      }
    }
  }

  const stripped = cleanOcrRewardName(text.replace(/^\d+\s*[%xX]\s*/, ''))
  const resolved = resolveName(stripped)
  if (matchCanonicalRewardName(resolved)) {
    const qtyM = text.match(/^(\d+)\s*[%xX]/)
    return {
      qty: qtyM ? Number(qtyM[1]) : 1,
      name: resolved,
      explicit: !!qtyM,
      raw: text,
    }
  }

  if (stripped.length >= 4 && /[a-z]/i.test(stripped)) {
    return { qty: 1, name: resolved ?? stripped, explicit: false, raw: text }
  }
  return null
}

function noisePenalty(raw: string): number {
  const letters = (raw.match(/[a-z]/gi) ?? []).length
  const ratio = letters / Math.max(1, raw.length)
  if (ratio < 0.45) return 80
  if (/[:|]{1,}/.test(raw)) return 25
  if (/\b[A-Z]{2,}\b/.test(raw) && !/\bx\b/i.test(raw)) return 15
  return 0
}

function scoreDecoded(d: DecodedRow, raw: string): number {
  let s = d.name.length
  if (d.explicit) s += 40
  if (matchCanonicalRewardName(d.name)) s += 80
  if (/\brune\b/i.test(d.name) || /\borb\b/i.test(d.name)) s += 20
  if (/\b(prism|bauble|jewell|uncut|gem)\b/i.test(d.name)) s += 15
  s -= noisePenalty(raw)
  return s
}

/** Pick the best decode from multiple OCR passes on the same row crop. */
export function pickBestRowDecode(reads: string[]): DecodedRow | null {
  let best: DecodedRow | null = null
  let bestScore = -1
  for (const raw of reads) {
    const d = decodeRowText(raw)
    if (!d) continue
    const s = scoreDecoded(d, raw)
    if (s > bestScore) {
      bestScore = s
      best = d
    }
  }
  return best
}
