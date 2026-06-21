import { buildTierMap } from './dataset'
import { extractOptions, resolveTier, valueToTier } from './match'
import type { Line } from './segment'

const map = buildTierMap()
const line = (text: string, x: number, y: number, h = 14): Line => ({ text, box: { x, y, w: 300, h } })

test('169% spells-that-cost-life resolves to the top of two tiers', () => {
  const r = resolveTier(map, '169% INCREASED SPELL DAMAGE WITH SPELLS THAT COST LIFE', 169)
  expect(r).toMatchObject({ rank: 2, count: 2, aboveTop: false })
})

test('OCR-form +N mod resolves against the item ladder (regression: + was dropped before)', () => {
  expect(resolveTier(map, '+174 TO MAXIMUM MANA', 174)?.count ?? 0).toBeGreaterThan(1)
})

test('value above the known top sets aboveTop', () => {
  expect(valueToTier([{ min: 9, max: 15, lvl: 1 }], 29)).toMatchObject({ min: 9 })
})

test('extractOptions matches a single clean line and ignores noise', () => {
  const opts = extractOptions(map, [line('SOME RANDOM UI THING 7', 900, 50), line('+174 TO MAXIMUM MANA', 100, 120)])
  expect(opts).toHaveLength(1)
  expect(opts[0].box.x).toBe(100)
})

test('extractOptions joins a wrap continuation and tolerates edge junk, preferring the full key', () => {
  const opts = extractOptions(map, [
    line('[4 169% INCREASED SPELL DAMAGE WITH SPELLS THAT COST', 100, 100),
    line('LIFE &', 100, 116),
  ])
  expect(opts).toHaveLength(1)
  expect(opts[0].result).toMatchObject({ rank: 2, count: 2 })
})
