import { buildTierMap } from './dataset'
import { normKey } from './normalize'

test('buildTierMap exposes the desecrated cost-Life ladder', () => {
  const map = buildTierMap()
  const tiers = map.get(normKey('(148-178)% increased Spell Damage with Spells that cost Life'))
  expect(tiers?.at(-1)).toMatchObject({ min: 148, max: 178 })
  expect(tiers?.[0]).toMatchObject({ min: 74, max: 89 })
})

test('buildTierMap includes item-domain ladders (max mana)', () => {
  const map = buildTierMap()
  expect((map.get(normKey('+(60-69) to maximum Mana'))?.length ?? 0)).toBeGreaterThan(1)
})
