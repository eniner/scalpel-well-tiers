import type { GameCapture, ScalpelPluginContext } from '@scalpelpoe/plugin-sdk'
import { buildTierMap } from './dataset'
import { detectBaseType } from './detect'
import { extractOptions, findOptionsBoundary } from './match'
import { ocrRegion } from './ocr'

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
// How far left of the leftmost option text (CSS px) to seat the label column.
const COLUMN_OFFSET = -5
// Scout pass: low-res OCR of the left side to find the item + the options region.
const SCOUT_W = 1300
// Read pass: high-res OCR of just the options strip (big text -> stable, complete).
const READ_W = 2600

const setFire = (ctx: ScalpelPluginContext, items: Label[]): Promise<void> =>
  ctx.storage.set('lastFire', { token: String(Date.now()), firedAt: Date.now(), items } satisfies Fire)

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

    // Pass 1 (scout): is this the well with an item, and where are the options?
    const leftW = frame.width * 0.72
    const scout = await ocrRegion(frame, { x: 0, y: 0, w: leftW, h: frame.height }, SCOUT_W)
    const base = detectBaseType(scout.words)
    const hintY = findOptionsBoundary(scout.lines)
    if (hintY == null) {
      // The "...reveal the Desecrated Modifier" hint isn't here -> not the well screen.
      ctx.log('well-tiers: well/desecrated screen not detected')
      await setFire(ctx, [])
      return
    }

    // The options sit between the hint and the CONFIRM button.
    let confirmY = frame.height
    for (const l of scout.lines) if (l.text.toUpperCase().includes('CONFIRM')) confirmY = Math.min(confirmY, l.box.y)
    if (confirmY >= frame.height) confirmY = hintY + frame.height * 0.35
    const pad = frame.height * 0.012

    // Pass 2 (read): high-res OCR of just the options strip.
    const read = await ocrRegion(frame, { x: 0, y: hintY - pad, w: frame.width * 0.62, h: confirmY - hintY + pad * 2 }, READ_W)
    const map = buildTierMap(base)
    const options = extractOptions(map, read.lines)

    const placed = options.map(({ box, result: r }) => ({
      x: frame.origin.x + box.x / frame.scale,
      y: frame.origin.y + (box.y + box.h / 2) / frame.scale,
      text: r.aboveTop ? 'T1?' : `T${r.count - r.rank + 1}`,
      top: r.rank === r.count,
    }))
    const columnX = placed.length ? Math.min(...placed.map((p) => p.x)) - COLUMN_OFFSET : 0
    const items: Label[] = placed.map((p) => ({ ...p, x: columnX }))
    await setFire(ctx, items)
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
        current = r.items
        clearAt = r.firedAt + CLEAR_MS
        draw(current)
      } else if (clearAt && Date.now() > clearAt) {
        clearAt = 0
        current = null
        container.innerHTML = ''
      } else if (current && current.length > 0 && container.childElementCount === 0) {
        draw(current)
      }
    }

    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  })
}
