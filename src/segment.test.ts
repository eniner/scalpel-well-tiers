import { toLines } from './segment'

const w = (text: string, x: number, y: number, jit = 0) => ({
  text,
  bbox: { x0: x, y0: y + jit, x1: x + 40, y1: y + 12 + jit },
  confidence: 90,
})

test('splits a row into separate lines across a wide horizontal gap', () => {
  // "169% LIFE" on the left, "INVENTORY" far right on the SAME row -> two lines.
  const lines = toLines([w('169%', 10, 100), w('LIFE', 55, 100), w('INVENTORY', 900, 100)])
  expect(lines).toHaveLength(2)
  expect(lines.find((l) => l.text === '169% LIFE')).toBeTruthy()
  expect(lines.find((l) => l.text === 'INVENTORY')).toBeTruthy()
})

test('keeps reading order within a line despite per-word y jitter', () => {
  const lines = toLines([w('A', 10, 100, 0), w('B', 55, 100, 2), w('C', 100, 100, -1)])
  expect(lines).toHaveLength(1)
  expect(lines[0].text).toBe('A B C')
})

test('drops low-confidence junk', () => {
  const junk = { text: 'x', bbox: { x0: 0, y0: 0, x1: 5, y1: 5 }, confidence: 10 }
  expect(toLines([junk, w('GAIN', 10, 200)])).toHaveLength(1)
})
