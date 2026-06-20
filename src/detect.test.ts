import { detectBaseType } from './detect'

const w = (text: string, x: number, y = 100) => ({ text, bbox: { x0: x, y0: y, x1: x + 40, y1: y + 12 }, confidence: 90 })

test('detects a known base type from OCR words, longest match wins', () => {
  expect(detectBaseType([w('HORROR', 10), w('WEAVER', 60), w('GELID', 10, 130), w('STAFF', 60, 130)])).toBe('Gelid Staff')
})

test('returns null when no base name is present', () => {
  expect(detectBaseType([w('TOTALLY', 10), w('RANDOM', 60), w('WORDS', 110)])).toBe(null)
})
