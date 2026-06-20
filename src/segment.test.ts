import { segment } from './segment'

const w = (text: string, y: number, x = 10) => ({
  text,
  bbox: { x0: x, y0: y, x1: x + 50, y1: y + 12 },
  confidence: 90,
})

test('groups two close lines into one option, far line into another', () => {
  const opts = segment([w('169%', 100), w('SPELLS', 100, 70), w('THAT COST LIFE', 114), w('+174 MANA', 200)])
  expect(opts).toHaveLength(2)
  expect(opts[0].text).toContain('169%')
  expect(opts[0].text).toContain('THAT COST LIFE')
  expect(opts[1].text).toContain('174')
})

test('drops low-confidence junk words', () => {
  const junk = { text: 'a4', bbox: { x0: 0, y0: 0, x1: 5, y1: 5 }, confidence: 10 }
  expect(segment([junk, w('+174 MANA', 200)])).toHaveLength(1)
})
