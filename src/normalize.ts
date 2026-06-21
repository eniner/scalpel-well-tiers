function stripMarkup(text: string): string {
  return (text || '').replace(/\[([^\]|]+)\|([^\]]+)\]/g, '$2').replace(/\[([^\]]+)\]/g, '$1')
}

export function normKey(text: string): string {
  return stripMarkup(text)
    .toUpperCase()
    .replace(/[+-]?\([0-9.]+-[0-9.]+\)/g, '#')
    .replace(/[+-]?[0-9][0-9.,]*/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The rolled value of a mod line. Prefer the number attached to `%` or a leading
 *  `+`, so OCR junk (e.g. a stray "[4" before "169%") doesn't steal the value. */
export function extractValue(text: string): number | null {
  const tagged = text.match(/([+-]?\d[\d.,]*)\s*%/) || text.match(/\+\s*(\d[\d.,]*)/)
  if (tagged) return Number(tagged[1].replace(/,/g, ''))
  const any = text.match(/[+-]?\d[\d.,]*/)
  return any ? Number(any[0].replace(/,/g, '')) : null
}
