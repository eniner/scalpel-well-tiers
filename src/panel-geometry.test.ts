import { expect, test } from 'vitest'
import { rewardRowBandsForCount } from './panel-geometry'
import { panelRect } from './row-read'

test('rewardRowBandsForCount extends ninth row below calibrated 8-row bottom', () => {
  const panel = panelRect({ height: 1080 })
  const eight = rewardRowBandsForCount(panel, 8)
  const nine = rewardRowBandsForCount(panel, 9)
  expect(nine).toHaveLength(9)
  expect(nine[0]!.y).toBeCloseTo(eight[0]!.y, 0)
  expect(nine[8]!.y).toBeGreaterThan(eight[7]!.y + 30)
})
