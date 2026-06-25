import { matchCanonicalRewardName, isKnownRewardName, canonicalRewardCount } from './rewards-catalog'

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
