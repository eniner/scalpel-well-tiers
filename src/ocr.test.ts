import { clusterWordsToLines, stabilizeRewardLines } from './ocr'
import type { Line, Word } from './segment'

const w = (text: string, x0: number, y0: number, x1 = x0 + 40, y1 = y0 + 16): Word => ({
  text,
  confidence: 80,
  bbox: { x0, y0, x1, y1 },
})

test('clusterWordsToLines groups words on the same row by Y', () => {
  const lines = clusterWordsToLines(
    [
      w('3x', 30, 200),
      w('Prism', 70, 198),
      w('3x', 30, 250),
      w('Bauble', 70, 248),
    ],
    20,
  )
  expect(lines).toHaveLength(2)
  expect(lines[0].text).toBe('3x Prism')
  expect(lines[1].text).toBe('3x Bauble')
})

test('stabilizeRewardLines keeps the richer read when tess and cluster disagree', () => {
  const tess: Line[] = [{ text: 'Prism', box: { x: 30, y: 200, w: 50, h: 16 } }]
  const words = [w('3x', 30, 200), w('Prism', 70, 200)]
  const out = stabilizeRewardLines(tess, words, 20)
  expect(out).toHaveLength(1)
  expect(out[0].text).toBe('3x Prism')
})
