import { buildTierMap } from './dataset'
import { resolveTier, valueToTier } from './match'

const map = buildTierMap()

test('169% spells-that-cost-life resolves to the top of two tiers', () => {
  const r = resolveTier(map, '169% INCREASED SPELL DAMAGE WITH SPELLS THAT COST LIFE', 169)
  expect(r).toMatchObject({ rank: 2, count: 2, aboveTop: false })
})

test('value above the known top sets aboveTop', () => {
  const tiers = [{ min: 9, max: 15, lvl: 1 }]
  expect(valueToTier(tiers, 29)).toBe(tiers[0])
})

test('unknown line returns null', () => {
  expect(resolveTier(map, 'TOTALLY UNKNOWN MOD TEXT', 5)).toBe(null)
})
