import {
  buildPriceIndex,
  type Candidate,
  cleanOcrRewardName,
  expandTruncatedRewardName,
  extractRewardSegments,
  fmtNum,
  mergeFragmentedOcrLines,
  parseRewardCandidates,
  type PriceLike,
  priceRewards,
  sanitizeOcrRewardLine,
} from './rewards'
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

test('splits multiple rewards merged onto one OCR line', () => {
  const c = parseRewardCandidates([line("2x Gemcutter's Prism 2x Glassblower's Bauble")])
  expect(c).toHaveLength(2)
  expect(c[0]).toMatchObject({ qty: 2, name: "Gemcutter's Prism" })
  expect(c[1]).toMatchObject({ qty: 2, name: "Glassblower's Bauble" })
})

test('strips trailing icon junk from reward names', () => {
  expect(cleanOcrRewardName("Gemcutter's Prism NG")).toBe("Gemcutter's Prism")
  expect(cleanOcrRewardName('Prism 158')).toBe('Prism')
  expect(cleanOcrRewardName('Prism/')).toBe('Prism')
})

test('matches possessive OCR slips via norm folding', () => {
  const idx = buildPriceIndex([{ name: "Gemcutter's Prism", chaosValue: 2.1 }])
  const p = priceRewards([cand('Gemcutters Prism', 2, true)], idx)
  expect(p[0].text).toBe('4.2 ex')
  expect(p[0].name).toBe("Gemcutter's Prism")
})

test('prices uncut gems without a level using the per-level median', () => {
  const idx = buildPriceIndex([
    { name: 'Uncut Spirit Gem (Level 8)', chaosValue: 10, divineValue: 0.1 },
    { name: 'Uncut Spirit Gem (Level 12)', chaosValue: 30, divineValue: 0.3 },
    { name: 'Uncut Spirit Gem (Level 16)', chaosValue: 50, divineValue: 0.5 },
  ])
  const p = priceRewards([cand('Uncut Spirit Gem', 1, false)], idx)
  expect(p[0].text).toBe('30 ex')
})

test('keeps reward-shaped lines without Nx as ? when unpriced', () => {
  const idx = buildPriceIndex(ENTRIES)
  const p = priceRewards([cand('Uncut Spirit Gem', 1, false)], idx)
  expect(p).toHaveLength(1)
  expect(p[0].text).toBe('?')
})

test('extractRewardSegments pulls every stack from a noisy line', () => {
  expect(extractRewardSegments('NG 1x Lesser Jewellers Orb')).toEqual([
    { qty: 1, name: "Lesser Jewellers Orb" },
  ])
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
    { name: 'Divine Orb', chaosValue: 5 },
    { name: 'Divine Orb', chaosValue: 50 },
  ])
  expect(priceRewards([cand('Divine Orb', 1, true)], idx)[0].text).toBe('?')
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

test('merges a lone Nx row into the next reward line', () => {
  const merged = mergeFragmentedOcrLines([line('2x', 100), line('Uncut Spirit Gem', 130)])
  expect(merged).toHaveLength(1)
  expect(merged[0].text).toBe('2x Uncut Spirit Gem')
})

test('partial tail names resolve when unique in the index', () => {
  const idx = buildPriceIndex([
    { name: "Gemcutter's Prism", chaosValue: 1.3 },
    { name: "Glassblower's Bauble", chaosValue: 1.5 },
    { name: "Lesser Jeweller's Orb", chaosValue: 8 },
    { name: 'Warding Rune of Protection', chaosValue: 2 },
  ])
  expect(priceRewards([cand('Prism', 2, true)], idx)[0]).toMatchObject({
    name: "Gemcutter's Prism",
    text: '2.6 ex',
  })
  expect(priceRewards([cand('Bauble', 2, true)], idx)[0]).toMatchObject({
    name: "Glassblower's Bauble",
    text: '3 ex',
  })
  expect(priceRewards([cand('Lesser Orb', 1, true)], idx)[0]).toMatchObject({
    name: "Lesser Jeweller's Orb",
    text: '8 ex',
  })
  expect(priceRewards([cand('Lesser f', 1, true)], idx)[0]).toMatchObject({
    name: "Lesser Jeweller's Orb",
    text: '8 ex',
  })
  expect(priceRewards([cand('Warding Rune of Protec', 1, true)], idx)[0]).toMatchObject({
    name: 'Warding Rune of Protection',
    text: '2 ex',
  })
})

test('dedupePriceEntries collapses identical duplicate rows', () => {
  const idx = buildPriceIndex([
    { name: 'Orb of Transmutation', chaosValue: 0.005 },
    { name: 'Orb of Transmutation', chaosValue: 0.005 },
  ])
  expect(priceRewards([cand('Orb of Transmutation', 2, true)], idx)[0].text).toBe('0.01 ex')
})

test('greater jeweller truncations map to the priced orb', () => {
  const idx = buildPriceIndex([{ name: "Greater Jeweller's Orb", chaosValue: 40 }])
  expect(priceRewards([cand('Greater Jewell', 1, true)], idx)[0]).toMatchObject({
    name: "Greater Jeweller's Orb",
    text: '40 ex',
  })
})

test('expandTruncatedRewardName maps common OCR fragments', () => {
  expect(expandTruncatedRewardName('Prism')).toBe("Gemcutter's Prism")
  expect(expandTruncatedRewardName('Lesser f')).toBe("Lesser Jeweller's Orb")
  expect(expandTruncatedRewardName('Greater')).toBe("Greater Jeweller's Orb")
  expect(expandTruncatedRewardName('Buble')).toBe("Glassblower's Bauble")
  expect(expandTruncatedRewardName('Warding Rune of Protec')).toBe('Warding Rune of Protection')
})

test('sanitizeOcrRewardLine fixes percent-for-x and missing Orb', () => {
  expect(sanitizeOcrRewardLine('St 2% of Transmutation')).toBe('2x Orb of Transmutation')
  expect(sanitizeOcrRewardLine('st 2 2x Prism')).toBe('2x Prism')
  expect(sanitizeOcrRewardLine('a 2X orb of').toLowerCase()).toBe('2x orb of')
})

test('prices a real scan dump with buuble, gold, and percent slips', () => {
  const idx = buildPriceIndex([
    { name: "Gemcutter's Prism", chaosValue: 1.3 },
    { name: "Glassblower's Bauble", chaosValue: 1.3 },
    { name: 'Orb of Transmutation', chaosValue: 0.13 },
    { name: 'Orb of Augmentation', chaosValue: 0.17 },
    { name: 'Uncut Spirit Gem (Level 12)', chaosValue: 18 },
  ])
  const lines = mergeFragmentedOcrLines([
    line('3x', 215),
    line('3X Buble', 243),
    line('st 2 2x Prism', 300),
    line('Uncut Gold', 434),
    line('St 2% of Transmutation', 489),
    line('a 2X orb of', 526),
  ])
  const priced = priceRewards(parseRewardCandidates(lines), idx)
  expect(priced.find((p) => p.name === "Glassblower's Bauble" && p.qty === 3)?.text).toBe('3.9 ex')
  expect(priced.find((p) => p.name === 'Uncut Spirit Gem')?.text).toBe('18 ex')
  expect(priced.find((p) => p.name === 'Orb of Transmutation')?.text).toBe('0.26 ex')
  expect(priced.find((p) => p.name === 'Orb of Augmentation')?.text).toBe('0.34 ex')
})

test('parses quantity without an x separator', () => {
  const c = parseRewardCandidates([line('2 Uncut Spirit Gem', 449)])
  expect(c[0]).toMatchObject({ qty: 2, name: 'Uncut Spirit Gem', explicit: true })
})

test('completes a split orb-of row when transmutation is already on the panel', () => {
  const idx = buildPriceIndex([
    { name: 'Orb of Transmutation', chaosValue: 0.13 },
    { name: 'Orb of Augmentation', chaosValue: 0.17 },
  ])
  const cands = parseRewardCandidates([
    line('2x Orb of Transmutation', 479),
    line('2x Orb of', 542),
  ])
  const priced = priceRewards(cands, idx)
  expect(priced.find((p) => p.box.y === 542)?.text).toBe('0.34 ex')
  expect(priced.find((p) => p.box.y === 542)?.name).toBe('Orb of Augmentation')
})

test('prices Greater from a split jeweller row', () => {
  const idx = buildPriceIndex([{ name: "Greater Jeweller's Orb", chaosValue: 6.5 }])
  expect(priceRewards([cand('Greater', 1, true)], idx)[0]).toMatchObject({
    name: "Greater Jeweller's Orb",
    text: '6.5 ex',
  })
})
