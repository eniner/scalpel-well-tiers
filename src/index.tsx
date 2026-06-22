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
interface DiagMod {
  tier: string
  text: string
}
interface Diag {
  loading: boolean
  base: string | null
  mods: DiagMod[]
  note: string | null
}
interface Fire {
  token: string
  firedAt: number
  open: boolean
  items: Label[]
  diag: Diag
}

// Label column X as a fraction of the game width from the left edge (the well box
// sits at a fixed screen position, so this is stable regardless of OCR).
const LABEL_COLUMN_FRAC = 0.228
const SCOUT_W = 1300
const READ_W = 2600
const EMPTY_DIAG: Diag = { loading: false, base: null, mods: [], note: null }

const prettyRead = (t: string): string =>
  t
    .replace(/[^A-Za-z0-9 %+().,-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48)

const setFire = (ctx: ScalpelPluginContext, open: boolean, items: Label[], diag: Diag): Promise<void> =>
  ctx.storage.set('lastFire', { token: String(Date.now()), firedAt: Date.now(), open, items, diag } satisfies Fire)

export default function activate(ctx: ScalpelPluginContext): void {
  if (ctx.getPoeVersion() !== 2) return

  let busy = false

  ctx.registerHotkey({ label: 'Reveal well tiers' }, async () => {
    if (busy) return
    // If something is already on screen, the hotkey just closes it - never
    // recapture (that would OCR our own labels back into the image).
    const cur = await ctx.storage.get<Fire>('lastFire')
    if (cur?.open) {
      await setFire(ctx, false, [], EMPTY_DIAG)
      ctx.closeOverlay()
      return
    }

    const frame: GameCapture | null = await ctx.captureGameWindow()
    if (!frame) {
      ctx.log('well-tiers: PoE not focused')
      return
    }
    busy = true
    try {
      await setFire(ctx, true, [], { loading: true, base: null, mods: [], note: null })
      ctx.openOverlay()

      const leftW = frame.width * 0.72
      const scout = await ocrRegion(frame, { x: 0, y: 0, w: leftW, h: frame.height }, SCOUT_W)
      const base = detectBaseType(scout.words)
      const hintY = findOptionsBoundary(scout.lines)
      if (hintY == null) {
        ctx.log('well-tiers: well/desecrated screen not detected')
        await setFire(ctx, true, [], { loading: false, base, mods: [], note: 'Not at the Well of Souls' })
        return
      }

      let confirmY = frame.height
      for (const l of scout.lines) if (l.text.toUpperCase().includes('CONFIRM')) confirmY = Math.min(confirmY, l.box.y)
      if (confirmY >= frame.height) confirmY = hintY + frame.height * 0.35
      const pad = frame.height * 0.012

      const read = await ocrRegion(frame, { x: 0, y: hintY - pad, w: frame.width * 0.62, h: confirmY - hintY + pad * 2 }, READ_W)
      const map = buildTierMap(base)
      const options = extractOptions(map, read.lines)

      const columnX = frame.origin.x + frame.gameSize.width * LABEL_COLUMN_FRAC
      const items: Label[] = options.map(({ box, result: r }) => ({
        x: columnX,
        y: frame.origin.y + (box.y + box.h / 2) / frame.scale,
        text: r.aboveTop ? 'T1?' : `T${r.count - r.rank + 1}`,
        top: r.rank === r.count,
      }))
      const mods: DiagMod[] = options.map((o) => ({ tier: o.result.aboveTop ? 'T1?' : `T${o.result.count - o.result.rank + 1}`, text: prettyRead(o.text) }))
      await setFire(ctx, true, items, { loading: false, base, mods, note: mods.length ? null : 'No options read' })
      ctx.log(`well-tiers: base=${base ?? 'unknown'}, ${items.length} tiers`)
    } finally {
      busy = false
    }
  })

  ctx.registerOverlay({ mode: 'annotation', title: 'Well Tiers' }, (container) => {
    let drawnToken = ''
    let current: { items: Label[]; diag: Diag } | null = null

    const close = () => {
      current = null
      container.innerHTML = ''
      void setFire(ctx, false, [], EMPTY_DIAG)
      ctx.closeOverlay()
    }

    const drawDiag = (d: Diag) => {
      const panel = document.createElement('div')
      panel.style.cssText =
        'position:absolute;left:0;top:8px;min-width:190px;max-width:320px;background:rgba(23,24,33,0.97);color:#e0d8cc;border:1px solid rgba(56,56,77,0.7);border-left:none;border-radius:0 8px 8px 0;font:12px/1.45 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,0.5);overflow:hidden;pointer-events:none'
      const title = document.createElement('div')
      title.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 6px 3px 10px;font-weight:700;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#c8a96e;background:rgba(0,0,0,0.25);border-bottom:1px solid rgba(56,56,77,0.6)'
      const label = document.createElement('span')
      label.textContent = 'Scalpel OCR'
      const x = document.createElement('span')
      x.textContent = '✕'
      x.title = 'Hover to close'
      x.style.cssText = 'pointer-events:auto;cursor:pointer;padding:1px 6px;border-radius:3px;color:#9e9480;font-size:12px;line-height:1;transition:color 0.1s,background 0.1s'
      let dwell: ReturnType<typeof setTimeout> | null = null
      x.addEventListener('mouseenter', () => {
        x.style.color = '#ef5350'
        x.style.background = 'rgba(239,83,80,0.15)'
        dwell = setTimeout(close, 300)
      })
      x.addEventListener('mouseleave', () => {
        x.style.color = '#9e9480'
        x.style.background = 'transparent'
        if (dwell) clearTimeout(dwell)
        dwell = null
      })
      title.append(label, x)
      panel.appendChild(title)
      const body = document.createElement('div')
      body.style.cssText = 'padding:7px 10px;white-space:pre-wrap'
      if (d.loading) body.textContent = 'loading...'
      else if (d.note) body.textContent = `${d.base ? `Base: ${d.base}\n` : ''}${d.note}`
      else body.textContent = [`Base: ${d.base ?? '(unknown)'}`, ...d.mods.map((m) => `${m.tier} - ${m.text}`)].join('\n')
      panel.appendChild(body)
      container.appendChild(panel)
    }

    const draw = (state: { items: Label[]; diag: Diag }) => {
      container.innerHTML = ''
      drawDiag(state.diag)
      for (const it of state.items) {
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
      if (!r) return
      if (r.token !== drawnToken) {
        drawnToken = r.token
        if (r.open) {
          current = { items: r.items, diag: r.diag }
          draw(current)
        } else {
          current = null
          container.innerHTML = ''
        }
      } else if (current && container.childElementCount === 0) {
        draw(current)
      }
    }

    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  })
}
