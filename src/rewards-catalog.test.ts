import { matchCanonicalRewardName, isKnownRewardName, canonicalRewardCount } from './rewards-catalog'
import catalog from './data/runeshape-rewards.json'

test('catalog includes warding and standard socket runes', () => {
  expect(canonicalRewardCount()).toBeGreaterThan(100)
  expect(isKnownRewardName("Warding Rune of Protection")).toBe(true)
  expect(isKnownRewardName('Greater Inspiration Rune')).toBe(true)
  expect(isKnownRewardName('Inspiration Rune')).toBe(true)
})

test('matches truncated warding rune OCR', () => {
  expect(matchCanonicalRewardName('Warding Rune of Protec')).toBe('Warding Rune of Protection')
  expect(matchCanonicalRewardName('Warding Rune of Protect')).toBe('Warding Rune of Protection')
})

test('matches truncated greater rune OCR', () => {
  expect(matchCanonicalRewardName('Greater Inspirati')).toBe('Greater Inspiration Rune')
})

test('rejects unknown noise', () => {
  expect(matchCanonicalRewardName('GAME')).toBeNull()
  expect(matchCanonicalRewardName('Se')).toBeNull()
})

// Adversarial: the catalog has many near-identical names (tiered runes, 17
// "Warding Rune of ..." entries, 13 "Ancient Rune of ..." entries). A clean read
// of any real name must round-trip to ITSELF, never collapse onto a sibling. A
// failure here means two names normalize to the same key, or the fuzzy fallback
// is aliasing distinct rewards.
test('every canonical name round-trips to itself', () => {
  const misses: string[] = []
  for (const name of catalog.names) {
    if (matchCanonicalRewardName(name) !== name) misses.push(name)
  }
  expect(misses).toEqual([])
})

test('tier-prefixed truncations resolve to the correct tier, not a sibling', () => {
  expect(matchCanonicalRewardName('Iron Rune')).toBe('Iron Rune')
  expect(matchCanonicalRewardName('Lesser Iro')).toBe('Lesser Iron Rune')
  expect(matchCanonicalRewardName('Greater Iro')).toBe('Greater Iron Rune')
  expect(matchCanonicalRewardName('Perfect Iro')).toBe('Perfect Iron Rune')
})

test('similar short rune names pick the nearer one, not a tie-guess', () => {
  // Storm vs Stone differ by one char; a single-error OCR slip must land on the
  // intended name rather than flip-flop or null out.
  expect(matchCanonicalRewardName('Storn Rune')).toBe('Storm Rune')
  expect(matchCanonicalRewardName('Ston Rune')).toBe('Stone Rune')
})

test('genuinely ambiguous fragments return null instead of guessing', () => {
  // "Ancient Rune of D" prefixes Decay/Detonation/Discovery/Dueling.
  expect(matchCanonicalRewardName('Ancient Rune of D')).toBeNull()
  // "Warding Rune of S" prefixes Salvaging/Stability/Symbiosis.
  expect(matchCanonicalRewardName('Warding Rune of S')).toBeNull()
})
