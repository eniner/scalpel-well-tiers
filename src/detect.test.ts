import { detectBaseType, nearestBase } from './detect'

const w = (text: string, x: number, y = 100) => ({ text, bbox: { x0: x, y0: y, x1: x + 40, y1: y + 12 }, confidence: 90 })

test('detects a known base type from OCR words, longest match wins', () => {
  const m = detectBaseType([w('HORROR', 10), w('WEAVER', 60), w('GELID', 10, 130), w('STAFF', 60, 130)])
  expect(m?.name).toBe('Gelid Staff')
  expect(m?.box).toMatchObject({ x: 10, y: 130 })
})

test('returns null when no base name is present', () => {
  expect(detectBaseType([w('TOTALLY', 10), w('RANDOM', 60), w('WORDS', 110)])).toBe(null)
})

test('fuzzy-matches a base name despite an OCR character error', () => {
  // "Chain Tiara" misread as "Chain Tlara" (I -> L) still resolves.
  expect(detectBaseType([w('Chain', 10), w('Tlara', 60)])?.name).toBe('Chain Tiara')
})

test('nearestBase reports the closest base + distance for diagnostics', () => {
  const near = nearestBase([w('Chaln', 10), w('Tlara', 60)])
  expect(near?.name).toBe('Chain Tiara')
  expect(near?.dist).toBeGreaterThan(0)
})
