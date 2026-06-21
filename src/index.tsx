import type { GameCapture, ScalpelPluginContext } from '@scalpelpoe/plugin-sdk'
import { buildTierMap } from './dataset'
import { detectBaseType } from './detect'
import { extractOptions } from './match'
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

export default function activate(ctx: ScalpelPluginContext): void {
  if (ctx.getPoeVersion() !== 2) return

  ctx.registerHotkey({ label: 'Reveal well tiers' }, async () => {
    const frame: GameCapture | null = await ctx.captureGameWindow()
    if (!frame) {
      ctx.log('well-tiers: PoE not focused')
      return
    }
    // Immediate feedback during the OCR pass.
    await ctx.storage.set('lastFire', {
      token: `reading-${Date.now()}`,
      firedAt: Date.now(),
      items: [{ x: frame.origin.x + frame.gameSize.width * 0.32, y: frame.origin.y + frame.gameSize.height * 0.28, text: 'reading tiers...', top: false }],
    } satisfies Fire)
    ctx.openOverlay()

    const { words, lines } = await runOcr(frame)
    const base = detectBaseType(words)
    const map = buildTierMap(base)
    const options = extractOptions(map, lines)
    const items: Label[] = options.map(({ box, result: r }) => ({
      x: frame.origin.x + box.x / frame.scale,
      y: frame.origin.y + box.y / frame.scale,
      text: r.aboveTop ? '>=T1?' : `T${r.count - r.rank + 1}/${r.count}`,
      top: r.rank === r.count,
    }))
    await ctx.storage.set('lastFire', { token: String(Date.now()), firedAt: Date.now(), items } satisfies Fire)
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
        drawnToken = r.token
        // Don't let an empty re-capture wipe good labels that are still fresh.
        if (r.items.length === 0 && current && current.length > 0 && Date.now() < clearAt) return
        current = r.items
        clearAt = r.firedAt + CLEAR_MS
        draw(current)
      } else if (clearAt && Date.now() > clearAt) {
        clearAt = 0
        current = null
        container.innerHTML = ''
      } else if (current && container.childElementCount === 0) {
        draw(current) // host wiped the surface while we should be visible: restore
      }
    }

    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  })
}
