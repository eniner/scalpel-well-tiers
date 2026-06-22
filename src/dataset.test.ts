import { BASE_NAMES, buildTierMap } from './dataset'
import { normKey } from './normalize'

test('buildTierMap exposes the desecrated cost-Life ladder', () => {
  const map = buildTierMap()
  const ladders = map.get(normKey('(148-178)% increased Spell Damage with Spells that cost Life'))
  expect(ladders?.length).toBeGreaterThanOrEqual(1)
  const tiers = ladders![0]
  expect(tiers.at(-1)).toMatchObject({ min: 148, max: 178 })
  expect(tiers[0]).toMatchObject({ min: 74, max: 89 })
})

test('BASE_NAMES maps uppercased OCR text back to the original base name', () => {
  expect(BASE_NAMES.get('GELID STAFF')).toBe('Gelid Staff')
})

test('base-scoping yields a narrower mana pool than the merged fallback', () => {
  const key = normKey('+(60-69) to maximum Mana')
  const mergedLadders = buildTierMap().get(key) ?? []
  const scopedLadders = buildTierMap('Gelid Staff').get(key) ?? []
  const mergedTiers = mergedLadders.flat().length
  const scopedTiers = scopedLadders.flat().length
  expect(mergedTiers).toBeGreaterThan(0)
  expect(scopedTiers).toBeGreaterThan(0)
  expect(scopedTiers).toBeLessThanOrEqual(mergedTiers)
})
