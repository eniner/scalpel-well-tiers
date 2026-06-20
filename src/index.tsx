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

const CLEAR_MS = 12000

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
    let token = ''
    const tick = async () => {
      const r = await ctx.storage.get<Fire>('lastFire')
      if (!r || Date.now() - r.firedAt > CLEAR_MS) {
        if (container.childElementCount) container.innerHTML = ''
        return
      }
      if (r.token === token) return
      token = r.token
      container.innerHTML = ''
      for (const it of r.items) {
        const el = document.createElement('div')
        el.textContent = it.text
        el.style.cssText = `position:absolute;left:${it.x}px;top:${it.y}px;transform:translateX(-110%);font:bold 16px sans-serif;color:${
          it.top ? '#ffd24a' : '#cfd8dc'
        };text-shadow:0 0 3px #000,0 0 3px #000;pointer-events:none`
        container.appendChild(el)
      }
    }
    const id = setInterval(tick, 200)
    return () => clearInterval(id)
  })
}
