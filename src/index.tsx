import type { GameCapture, ScalpelPluginContext } from '@scalpelpoe/plugin-sdk'
import { buildTierMap } from './dataset'
import { detectBaseType } from './detect'
import { extractOptions } from './match'
import { runOcr } from './ocr'
import { toLines } from './segment'

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

export default function activate(ctx: ScalpelPluginContext): void {
  if (ctx.getPoeVersion() !== 2) return

  ctx.registerHotkey({ label: 'Reveal well tiers' }, async () => {
    const frame: GameCapture | null = await ctx.captureGameWindow()
    if (!frame) {
      ctx.log('well-tiers: PoE not focused')
      return
    }
    const words = await runOcr(frame)
    const base = detectBaseType(words)
    const map = buildTierMap(base)
    const lines = toLines(words)
    const options = extractOptions(map, lines)
    const items: Label[] = options.map(({ box, result: r }) => ({
      x: frame.origin.x + box.x / frame.scale,
      y: frame.origin.y + box.y / frame.scale,
      text: r.aboveTop ? '>=T1?' : `T${r.count - r.rank + 1}/${r.count}`,
      top: r.rank === r.count,
    }))
    const fire: Fire = { token: String(Date.now()), firedAt: Date.now(), items }
    await ctx.storage.set('lastFire', fire)
    ctx.openOverlay()
    ctx.log(`well-tiers: base=${base ?? 'unknown'}, ${items.length} tiers from ${lines.length} lines`)
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
        el.style.cssText = `position:absolute;left:${it.x}px;top:${it.y}px;transform:translateX(-110%);font:bold 16px sans-serif;color:${
          it.top ? '#ffd24a' : '#cfd8dc'
        };text-shadow:0 0 3px #000,0 0 3px #000;pointer-events:none`
        container.appendChild(el)
      }
    }

    const tick = async () => {
      let r: Fire | null = null
      try {
        r = await ctx.storage.get<Fire>('lastFire')
      } catch {
        return // transient read failure: keep what's on screen, never clear on noise
      }
      if (r && r.token !== drawnToken) {
        // A fresh fire: draw it and arm the local expiry.
        drawnToken = r.token
        current = r.items
        clearAt = r.firedAt + CLEAR_MS
        draw(current)
      } else if (clearAt && Date.now() > clearAt) {
        // Expired: clear once.
        clearAt = 0
        current = null
        container.innerHTML = ''
      } else if (current && container.childElementCount === 0) {
        // The host wiped the surface (show/hide cycle) while we should be visible: restore.
        draw(current)
      }
    }

    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  })
}
