import { expect, test } from 'vitest'
import { detectRewardRowBands } from './panel-layout'
import { panelRect } from './row-read'

function syntheticListFrame(rowCount: number, rowStepFrac: number) {
  const panel = panelRect({ height: 1080 })
  const w = 1920
  const h = 1080
  const pixels = new Uint8ClampedArray(w * h * 4)
  for (let row = 0; row < rowCount; row++) {
    const y = Math.round(panel.y + panel.h * 0.12 + row * (panel.h * rowStepFrac))
    for (let x = Math.round(panel.w * 0.35); x < Math.round(panel.w * 0.9); x++) {
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        const i = (yy * w + x) * 4
        pixels[i] = 220
        pixels[i + 1] = 210
        pixels[i + 2] = 180
        pixels[i + 3] = 255
      }
    }
  }
  return { pixels, width: w, height: h, panel }
}

test('detectRewardRowBands finds eight layout peaks', () => {
  const { pixels, width, height, panel } = syntheticListFrame(8, 0.075)
  const { bands, method } = detectRewardRowBands({ pixels, width, height }, panel)
  expect(method).toBe('layout-count')
  expect(bands.length).toBe(8)
})

test('detectRewardRowBands finds twelve layout peaks on dense page', () => {
  const { pixels, width, height, panel } = syntheticListFrame(12, 0.052)
  const { bands, method } = detectRewardRowBands({ pixels, width, height }, panel)
  expect(method).toBe('layout-count')
  expect(bands.length).toBe(12)
})
