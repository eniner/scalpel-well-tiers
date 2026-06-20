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

export function extractValue(text: string): number | null {
  const m = text.match(/[+-]?[0-9][0-9.,]*/)
  return m ? Number(m[0].replace(/,/g, '')) : null
}
