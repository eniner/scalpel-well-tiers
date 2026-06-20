import { BASE_NAMES, buildTierMap } from './dataset'
import { normKey } from './normalize'

test('buildTierMap exposes the desecrated cost-Life ladder', () => {
  const map = buildTierMap()
  const tiers = map.get(normKey('(148-178)% increased Spell Damage with Spells that cost Life'))
  expect(tiers?.at(-1)).toMatchObject({ min: 148, max: 178 })
  expect(tiers?.[0]).toMatchObject({ min: 74, max: 89 })
})

test('BASE_NAMES maps uppercased OCR text back to the original base name', () => {
  expect(BASE_NAMES.get('GELID STAFF')).toBe('Gelid Staff')
})

test('base-scoping yields a narrower lightning ladder than the merged fallback', () => {
  const key = normKey('Gain (9-15)% of Damage as Extra Lightning Damage')
  const merged = buildTierMap()?.get(key)?.length ?? 0
  const scoped = buildTierMap('Gelid Staff')?.get(key)?.length ?? 0
  expect(merged).toBeGreaterThan(1)
  expect(scoped).toBeGreaterThan(0)
  expect(scoped).toBeLessThan(merged)
})
