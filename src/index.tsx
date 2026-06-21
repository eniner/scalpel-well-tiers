import type { GameCapture, ScalpelPluginContext } from '@scalpelpoe/plugin-sdk'
import { buildTierMap } from './dataset'
import { detectBaseType } from './detect'
import { extractOptions, findOptionsBoundary } from './match'
import { runOcr } from './ocr'

interface Label {
  x: number
  y: number
  text: string
  top: boolean
}
interface Fire {
  token: string
  firedAt: number
  items: Label[]
}

const CLEAR_MS = 20000
// How far left of the leftmost option text (CSS px) to seat the label column, so it
// lands on the well box's left border rather than overlapping the mod text.
const COLUMN_OFFSET = -5

export default function activate(ctx: ScalpelPluginContext): void {
  if (ctx.getPoeVersion() !== 2) return

  ctx.registerHotkey({ label: 'Reveal well tiers' }, async () => {
    const frame: GameCapture | null = await ctx.captureGameWindow()
    if (!frame) {
      ctx.log('well-tiers: PoE not focused')
      return
    }
    await ctx.storage.set('lastFire', {
      token: `reading-${Date.now()}`,
      firedAt: Date.now(),
      items: [{ x: frame.origin.x + frame.gameSize.width * 0.32, y: frame.origin.y + frame.gameSize.height * 0.28, text: 'reading tiers...', top: false }],
    } satisfies Fire)
    ctx.openOverlay()

    const { words, lines } = await runOcr(frame)
    const base = detectBaseType(words)
    const map = buildTierMap(base)
    // Keep only the desecrated options (below the reveal hint); skip the item's existing tooltip mods.
    const boundary = findOptionsBoundary(lines)
    const optionLines = boundary == null ? lines : lines.filter((l) => l.box.y > boundary)
    const options = extractOptions(map, optionLines)

    // Position each label, then line them all up at one column (the box's left border)
    // and vertically center on each option's row.
    const placed = options.map(({ box, result: r }) => ({
      x: frame.origin.x + box.x / frame.scale,
      y: frame.origin.y + (box.y + box.h / 2) / frame.scale,
      text: r.aboveTop ? 'T1?' : `T${r.count - r.rank + 1}`,
      top: r.rank === r.count,
    }))
    const columnX = placed.length ? Math.min(...placed.map((p) => p.x)) - COLUMN_OFFSET : 0
    const items: Label[] = placed.map((p) => ({ ...p, x: columnX }))

    await ctx.storage.set('lastFire', { token: String(Date.now()), firedAt: Date.now(), items } satisfies Fire)
    ctx.log(`well-tiers: base=${base ?? 'unknown'}, ${items.length} tiers`)
  })

  ctx.registerOverlay({ mode: 'annotation', title: 'Well Tiers' }, (container) => {
    let drawnToken = ''
    let clearAt = 0
    let current: Label[] | null = null

    const draw = (items: Label[]) => {
      container.innerHTML = ''
      for (const it of items) {
        const el = document.createElement('div')
        el.textContent = it.text
        el.style.cssText = `position:absolute;left:${it.x}px;top:${it.y}px;transform:translate(-50%,-50%);font:bold 15px sans-serif;color:${
          it.top ? '#ffd24a' : '#e2e8f0'
        };background:rgba(0,0,0,0.82);padding:1px 6px;border-radius:3px;white-space:nowrap;pointer-events:none`
        container.appendChild(el)
      }
    }

    const tick = async () => {
      let r: Fire | null = null
      try {
        r = await ctx.storage.get<Fire>('lastFire')
      } catch {
        return
      }
      if (r && r.token !== drawnToken) {
        drawnToken = r.token
        if (r.items.length === 0 && current && current.length > 0 && Date.now() < clearAt) return
        current = r.items
        clearAt = r.firedAt + CLEAR_MS
        draw(current)
      } else if (clearAt && Date.now() > clearAt) {
        clearAt = 0
        current = null
        container.innerHTML = ''
      } else if (current && container.childElementCount === 0) {
        draw(current)
      }
    }

    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  })
}
