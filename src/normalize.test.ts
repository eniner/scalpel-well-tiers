import { extractValue, normKey } from './normalize'

test('normKey matches OCR text to dataset template', () => {
  expect(normKey('169% INCREASED SPELL DAMAGE WITH SPELLS THAT COST LIFE')).toBe(
    normKey('(148-178)% increased Spell Damage with Spells that cost Life'),
  )
  expect(normKey('+174 TO MAXIMUM MANA')).toBe('# TO MAXIMUM MANA')
})

test('extractValue pulls the rolled number', () => {
  expect(extractValue('169% INCREASED SPELL DAMAGE')).toBe(169)
  expect(extractValue('+174 TO MAXIMUM MANA')).toBe(174)
  expect(extractValue('GAIN 29% OF DAMAGE AS EXTRA LIGHTNING DAMAGE')).toBe(29)
  expect(extractValue('NO NUMBER HERE')).toBe(null)
})
