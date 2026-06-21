import { extractValue, normKey } from './normalize'

test('normKey matches OCR text to the dataset template', () => {
  expect(normKey('169% INCREASED SPELL DAMAGE WITH SPELLS THAT COST LIFE')).toBe(
    normKey('(148-178)% increased Spell Damage with Spells that cost Life'),
  )
  expect(normKey('+174 TO MAXIMUM MANA')).toBe('# TO MAXIMUM MANA')
})

test('normKey collapses +N and +(N-M) to the same key', () => {
  expect(normKey('+(35-50) to Spirit')).toBe('# TO SPIRIT')
  expect(normKey('+(35-50) to Spirit')).toBe(normKey('+174 to Spirit'))
})

test('extractValue prefers the %/+ tagged number over leading junk', () => {
  expect(extractValue('GAIN 29% OF DAMAGE AS EXTRA LIGHTNING DAMAGE')).toBe(29)
  expect(extractValue('+174 TO MAXIMUM MANA')).toBe(174)
  expect(extractValue('[4 169% INCREASED SPELL DAMAGE')).toBe(169)
  expect(extractValue('1,746 LIFE')).toBe(1746)
  expect(extractValue('NO NUMBER')).toBe(null)
})
