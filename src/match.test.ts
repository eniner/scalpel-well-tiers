import { buildTierMap } from './dataset'
import { extractOptions, resolveTier, valueToTier } from './match'
import type { Line } from './segment'

const map = buildTierMap()
const line = (text: string, x: number, y: number): Line => ({ text, box: { x, y, w: 300, h: 14 } })

test('169% spells-that-cost-life resolves to the top of two tiers', () => {
  const r = resolveTier(map, '169% INCREASED SPELL DAMAGE WITH SPELLS THAT COST LIFE', 169)
  expect(r).toMatchObject({ rank: 2, count: 2, aboveTop: false })
})

test('OCR-form +N mod resolves against the item ladder (regression: + was dropped before)', () => {
  const r = resolveTier(map, '+174 TO MAXIMUM MANA', 174)
  expect(r).not.toBeNull()
  expect(r!.count).toBeGreaterThan(1)
})

test('value above the known top sets aboveTop', () => {
  const tiers = [{ min: 9, max: 15, lvl: 1 }]
  expect(valueToTier(tiers, 29)).toBe(tiers[0])
})

test('extractOptions matches a single-line option and ignores noise', () => {
  const lines = [line('SOME INVENTORY LABEL', 900, 50), line('+174 TO MAXIMUM MANA', 100, 120)]
  const opts = extractOptions(map, lines)
  expect(opts).toHaveLength(1)
  expect(opts[0].box.x).toBe(100)
})

test('extractOptions joins a same-column wrap continuation', () => {
  // The mod text wraps: line 1 carries the value, line 2 below (x-overlapping) completes it.
  const lines = [
    line('169% INCREASED SPELL DAMAGE WITH SPELLS THAT COST', 100, 100),
    line('LIFE', 100, 116),
  ]
  const opts = extractOptions(map, lines)
  expect(opts).toHaveLength(1)
  expect(opts[0].result).toMatchObject({ rank: 2, count: 2 })
  expect(opts[0].box.h).toBeGreaterThan(14) // unioned across both lines
})
