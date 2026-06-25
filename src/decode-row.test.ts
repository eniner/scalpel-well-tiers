import { expect, test } from 'vitest'
import { decodeRowText } from './decode-row'

test('decodeRowText maps truncated jeweller orb OCR', () => {
  expect(decodeRowText('1x Greater Orb')?.name).toBe("Greater Jeweller's Orb")
  expect(decodeRowText('3x Prism 158')?.name).toBe("Gemcutter's Prism")
})
