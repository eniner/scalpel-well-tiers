import { buildPriceIndex, type Candidate, fmtNum, parseRewardCandidates, type PriceLike, priceRewards } from './rewards'
import type { Line } from './segment'

const line = (text: string, y = 0): Line => ({ text, box: { x: 30, y, w: 200, h: 20 } })
const cand = (name: string, qty = 1, explicit = qty !== 1): Candidate => ({
  name,
  qty,
  explicit,
  box: { x: 0, y: 0, w: 1, h: 1 },
})

const ENTRIES: PriceLike[] = [
  { name: 'Orb of Transmutation', chaosValue: 0.2 },
  { name: 'Orb of Augmentation', chaosValue: 0.5 },
  { name: 'Orb of Alchemy', chaosValue: 2 },
  { name: 'Divine Orb', chaosValue: 420, divineValue: 1 },
  { name: 'Mirror of Kalandra', chaosValue: 100000, divineValue: 240 },
]

test('parses rows with and without the Nx prefix; flags which had it', () => {
  const c = parseRewardCandidates([line('1x Orb of Transmutation'), line('Orb of Augmentation', 40)])
  expect(c[0]).toMatchObject({ qty: 1, name: 'Orb of Transmutation', explicit: true })
  expect(c[1]).toMatchObject({ qty: 1, name: 'Orb of Augmentation', explicit: false })
})

test('finds the Nx token after leading icon garbage and takes the name from there', () => {
  // Real read: the rune-shape icons OCR as "NG" prepended to the row.
  const c = parseRewardCandidates([line('NG 1x Orb of Transmutation')])
  expect(c[0]).toMatchObject({ qty: 1, name: 'Orb of Transmutation', explicit: true })
})

test('reads a multi-count stack from a noisy line', () => {
  expect(parseRewardCandidates([line('xX 3x Orb of Alchemy')])[0]).toMatchObject({ qty: 3, name: 'Orb of Alchemy' })
})

test('drops pure-number / too-short fragments (FPS counter, stray digits)', () => {
  const c = parseRewardCandidates([line('229'), line('3', 20), line('Se', 40), line('GAME', 60)])
  expect(c.map((x) => x.name)).toEqual(['GAME']) // only the lettered, long-enough line survives parse
})

test('the price list filters candidates: real items stay, header/noise drop', () => {
  const idx = buildPriceIndex(ENTRIES)
  // Simulates the observed scout: names without "1x", plus the header and noise.
  const c = parseRewardCandidates([
    line('Runeshape Combinations'),
    line('Orb of Transmutation', 30),
    line('GAME', 60),
    line('Orb of Augmentation', 90),
  ])
  const p = priceRewards(c, idx)
  expect(p.map((x) => x.name)).toEqual(['Orb of Transmutation', 'Orb of Augmentation'])
  expect(p[0].text).toBe('0.2 ex')
})

test('prices a stack in exalted and promotes to divine when it clears one', () => {
  const idx = buildPriceIndex(ENTRIES)
  const p = priceRewards([cand('Orb of Transmutation', 5), cand('Mirror of Kalandra', 1)], idx)
  expect(p[0].text).toBe('1 ex') // 0.2 * 5
  expect(p[1].text).toBe('240 div') // divineValue 240 * 1 >= 1
})

test('an explicit Nx row is kept even when unpriced (renders ?)', () => {
  const idx = buildPriceIndex(ENTRIES)
  const p = priceRewards([cand('Mystery Thing', 2, true), cand('Bare Unknown', 1, false)], idx)
  expect(p).toHaveLength(1) // the bare unknown is dropped; the explicit one stays
  expect(p[0]).toMatchObject({ name: 'Mystery Thing', text: '?', value: null })
})

test('ambiguous variant rows render ? rather than a guess', () => {
  const idx = buildPriceIndex([
    { name: 'Uncut Skill Gem', chaosValue: 5 },
    { name: 'Uncut Skill Gem', chaosValue: 50 },
  ])
  expect(priceRewards([cand('Uncut Skill Gem', 1, true)], idx)[0].text).toBe('?')
})

test('variant rows with equal value still price (not treated as ambiguous)', () => {
  const idx = buildPriceIndex([
    { name: 'Orb of Alchemy', chaosValue: 2 },
    { name: 'Orb of Alchemy', chaosValue: 2 },
  ])
  expect(priceRewards([cand('Orb of Alchemy', 2)], idx)[0].text).toBe('4 ex')
})

test('fuzzy-matches a single-character OCR slip and reports the canonical name', () => {
  const idx = buildPriceIndex(ENTRIES)
  const p = priceRewards([cand('Orb of Transmutaton')], idx)
  expect(p[0].text).toBe('0.2 ex')
  expect(p[0].name).toBe('Orb of Transmutation')
})

test('fmtNum mirrors the SDK price formatting', () => {
  expect(fmtNum(0.2)).toBe('0.2')
  expect(fmtNum(1)).toBe('1')
  expect(fmtNum(12)).toBe('12')
  expect(fmtNum(1500)).toBe('1.5k')
})
