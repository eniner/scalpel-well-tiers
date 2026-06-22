import type { GameCapture, ScalpelPluginContext } from '@scalpelpoe/plugin-sdk'
import { baseIconUrl, buildTierMap } from './dataset'
import { detectBaseType, nearestBase } from './detect'
import { extractOptions, findOptionsBoundary } from './match'
import { ocrRegion, setOcrProgress, warmWorkers } from './ocr'
import { SCALPEL_ICON } from './scalpel-icon'

interface Label {
  y: number
  text: string
  top: boolean
}
interface DiagMod {
  tier: string
  text: string
  top: boolean
}
interface Diag {
  loading: boolean
  base: string | null
  icon?: string | null
  mods: DiagMod[]
  note: string | null
  phase?: string
}
interface Fire {
  token: string
  firedAt: number
  open: boolean
  items: Label[]
  diag: Diag
}

// PoE side-panel (stash/inventory) width as a fraction of the game-window
// HEIGHT. PoE2 renders the panel at this width and re-centers the playfield by
// half of it when a side panel is open. Mirrors Scalpel's poe-geometry.ts
// (POE_SIDEBAR_RATIO); duplicated here because the plugin is self-contained.
const POE_SIDEBAR_RATIO = 370 / 600

// Tier badges form one vertical column, positioned as a horizontal offset from
// the Well of Souls' center. With the inventory open, the playfield (and the
// centered well dialog) re-centers to (width - sidebar)/2; we measure from
// there. The offset is a fraction of window HEIGHT - PoE UI scales with height,
// so a single value holds across resolutions and windowed/fullscreen. Negative
// = left of center. Tuned in-game to -0.25 (was a live tuner, now baked).
const DEFAULT_X_FROM_CENTER = -0.25

// Panel top inset as a fraction of game height - matches Scalpel's pinned
// zone-cheatsheet default anchor (fracY 0.08), so the panel sits where the
// cheatsheets mount.
const PANEL_TOP_FRAC = 0.08
const SCOUT_W = 1100
const READ_W = 2600
const BASE_W = 1600
const EMPTY_DIAG: Diag = { loading: false, base: null, mods: [], note: null }

// Map tesseract's raw status strings to user-facing phase labels. During a
// recognize pass the status is "recognizing text", which we render under the
// caller's current step ("Scanning screen" / "Reading affixes"); the init
// statuses (first run only) describe the one-time engine download.
const prettyStatus = (status: string, step: string): string => {
  const s = status.toLowerCase()
  if (s.includes('core')) return 'Loading OCR engine'
  if (s.includes('traineddata') || s.includes('language')) return 'Loading language data'
  if (s.includes('initializ')) return 'Initializing OCR'
  return step
}

const setFire = (ctx: ScalpelPluginContext, open: boolean, items: Label[], diag: Diag): Promise<void> =>
  ctx.storage.set('lastFire', { token: String(Date.now()), firedAt: Date.now(), open, items, diag } satisfies Fire)

// Minor words kept lowercase in the title-cased affix label (except as word 1).
const MINOR_WORDS = new Set(['of', 'the', 'on', 'to', 'per', 'with', 'and', 'a', 'an', 'in', 'for'])

/** Turn a matched mod's normalized key into a clean, title-cased affix label -
 *  e.g. "#% INCREASED RARITY OF ITEMS FOUND" -> "Increased Rarity of Items Found".
 *  Uses the canonical key (not the raw OCR text) so labels read consistently. */
const affixLabel = (key: string): string =>
  key
    .replace(/[+-]?#%?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .map((w, i) => (i > 0 && MINOR_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
    .replace(/^To\s+/, '')

export default function activate(ctx: ScalpelPluginContext): void {
  if (ctx.getPoeVersion() !== 2) return

  let busy = false

  // Pre-warm the OCR engine in the background so the first hotkey at the well
  // doesn't pay the multi-second init. OCR only runs in the hotkey handler (the
  // main-overlay process); the annotation render window never OCRs, so skip it
  // there to avoid spawning spare workers.
  if (!location.pathname.includes('annotation')) warmWorkers()

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
    // Surface what the OCR engine is doing - the first-run engine init is the
    // multi-second cost - so the panel explains the wait instead of a blank
    // "loading". Phase writes are throttled (identical text within 150ms is
    // dropped) since tesseract's logger fires far faster than the 250ms poll.
    let step = 'Scanning screen'
    let lastPhaseWrite = 0
    let lastPhaseText = ''
    const pushPhase = (text: string): void => {
      const now = Date.now()
      if (text === lastPhaseText && now - lastPhaseWrite < 150) return
      lastPhaseText = text
      lastPhaseWrite = now
      void setFire(ctx, true, [], { loading: true, base: null, mods: [], note: null, phase: text })
    }
    setOcrProgress((status, progress) => {
      const label = prettyStatus(status, step)
      const pct = Math.round(progress * 100)
      pushPhase(pct > 0 && pct < 100 ? `${label}... ${pct}%` : `${label}...`)
    })
    try {
      await setFire(ctx, true, [], { loading: true, base: null, mods: [], note: null, phase: 'Scanning screen...' })
      ctx.openOverlay()

      const leftW = frame.width * 0.72
      // 'sparse' mode + a lower target width: the scout only needs to locate the
      // hint/confirm tokens, so it skips full layout analysis over this big region.
      const scout = await ocrRegion(frame, { x: 0, y: 0, w: leftW, h: frame.height }, SCOUT_W, 'sparse')
      const hintY = findOptionsBoundary(scout.lines)
      if (hintY == null) {
        ctx.log('well-tiers: well/desecrated screen not detected')
        await setFire(ctx, true, [], { loading: false, base: null, mods: [], note: 'Not at the Well of Souls' })
        return
      }

      let confirmY = frame.height
      for (const l of scout.lines) if (l.text.toUpperCase().includes('CONFIRM')) confirmY = Math.min(confirmY, l.box.y)
      if (confirmY >= frame.height) confirmY = hintY + frame.height * 0.35
      const pad = frame.height * 0.012

      // Read two cropped regions at high res, CONCURRENTLY (two pooled workers):
      //  - base: the item tooltip - the right half of the playfield (right of the
      //    well centre, left of the inventory sidebar), above the options hint.
      //    A dedicated pass fixes the low-res scout garbling the small base text
      //    and false-matching option words ("Arcane Surge" -> "Arcane Dirk").
      //  - options: the affix strip below the hint line.
      // The base region spans scattered UI (keep full 'auto' layout - base
      // detection is sensitive); the options strip is a clean block, so 'block'
      // mode skips layout analysis there for speed.
      step = 'Reading affixes'
      pushPhase('Reading tooltip + affixes...')
      const sidebar = frame.height * POE_SIDEBAR_RATIO
      const wellCenter = (frame.width - sidebar) / 2
      const [baseRead, read] = await Promise.all([
        ocrRegion(frame, { x: wellCenter, y: 0, w: wellCenter, h: hintY }, BASE_W),
        ocrRegion(frame, { x: 0, y: hintY - pad, w: frame.width * 0.62, h: confirmY - hintY + pad * 2 }, READ_W, 'block'),
      ])
      const base = detectBaseType(baseRead.words)?.name ?? null
      // When the base isn't recognised, show the nearest base name + OCR distance
      // so a miss is diagnosable (char errors vs base text not read at all).
      const near = base ? null : nearestBase(baseRead.words)
      const baseLabel: string =
        base ?? (near ? `unknown (nearest: ${near.name} ~${near.dist})` : 'unknown (no base text read)')
      const baseIcon = base ? baseIconUrl(base) : null

      step = 'Matching tiers'
      pushPhase('Matching tiers...')
      const map = buildTierMap(base)
      const options = extractOptions(map, read.lines)

      // Badges share one X column, set in the overlay and measured from the
      // window's left edge; only the per-option Y comes from the OCR box here.
      const items: Label[] = options.map(({ box, result: r }) => ({
        y: frame.origin.y + (box.y + box.h / 2) / frame.scale,
        text: r.aboveTop ? 'T1?' : `T${r.count - r.rank + 1}`,
        top: r.rank === r.count,
      }))
      // Panel rows use the canonical (title-cased) affix name, not the raw OCR text.
      const mods: DiagMod[] = options.map((o) => ({
        tier: o.result.aboveTop ? 'T1?' : `T${o.result.count - o.result.rank + 1}`,
        text: affixLabel(o.key),
        top: o.result.rank === o.result.count,
      }))
      await setFire(ctx, true, items, { loading: false, base: baseLabel, icon: baseIcon, mods, note: mods.length ? null : 'No options read' })
      ctx.log(`well-tiers: base=${base ?? 'unknown'}, ${items.length} tiers`)
    } finally {
      setOcrProgress(null)
      busy = false
    }
  })

  ctx.registerOverlay({ mode: 'annotation', title: 'Scalpel OCR' }, (container) => {
    let drawnToken = ''
    let current: { items: Label[]; diag: Diag } | null = null

    // Badge column X: the well dialog's center is the re-centered playfield
    // center (width - sidebar)/2 with the inventory open, offset from there by
    // a fraction of window height. window.innerWidth/Height match gameSize.
    const columnLeft = (): number =>
      (window.innerWidth - POE_SIDEBAR_RATIO * window.innerHeight) / 2 + DEFAULT_X_FROM_CENTER * window.innerHeight

    // Drop the interactive region so the whole overlay is click-through again.
    const clearInteractive = () => ctx.setInteractiveRegion(null)

    const close = () => {
      current = null
      clearInteractive()
      container.innerHTML = ''
      void setFire(ctx, false, [], EMPTY_DIAG)
      ctx.closeOverlay()
    }

    // Standard Scalpel chrome: app-logo + "Scalpel OCR" title + a real close
    // button (the overlay is made clickable over this panel via the interactive
    // region below). Flush to the left edge, rounded on the right only - matches
    // the pinned cheatsheet windows.
    const buildPanel = (d: Diag): HTMLDivElement => {
      const panel = document.createElement('div')
      panel.style.cssText = `position:absolute;left:0;top:${(PANEL_TOP_FRAC * 100).toFixed(2)}%;min-width:200px;max-width:340px;background:rgba(23,24,33,0.99);color:#e0d8cc;border:1px solid rgba(56,56,77,0.5);border-left:none;border-radius:0 10px 10px 0;font:12px/1.45 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.55);overflow:hidden;pointer-events:auto`

      const title = document.createElement('div')
      title.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;padding:5px 5px 5px 12px;border-bottom:1px solid rgba(56,56,77,0.5)'
      const brand = document.createElement('span')
      brand.style.cssText =
        'display:flex;align-items:center;gap:6px;color:#c8a96e;font-weight:700;letter-spacing:1px;font-size:13px'
      const logo = document.createElement('img')
      logo.src = SCALPEL_ICON
      logo.alt = ''
      logo.style.cssText = 'width:16px;height:16px;display:block'
      const name = document.createElement('span')
      name.textContent = 'Scalpel OCR'
      brand.append(logo, name)

      const closeBtn = document.createElement('button')
      closeBtn.type = 'button'
      closeBtn.setAttribute('aria-label', 'Close')
      closeBtn.title = 'Close'
      closeBtn.style.cssText =
        'pointer-events:auto;width:30px;height:30px;display:flex;align-items:center;justify-content:center;padding:0;border:none;background:transparent;border-radius:8px;color:#9e9480;cursor:pointer;transition:background 0.1s,color 0.1s'
      closeBtn.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
      closeBtn.addEventListener('mouseenter', () => {
        closeBtn.style.background = '#2c2c3a'
        closeBtn.style.color = '#e0d8cc'
      })
      closeBtn.addEventListener('mouseleave', () => {
        closeBtn.style.background = 'transparent'
        closeBtn.style.color = '#9e9480'
      })
      closeBtn.addEventListener('click', close)
      title.append(brand, closeBtn)
      panel.appendChild(title)

      // Loading: just the phase line under the chrome.
      if (d.loading) {
        const body = document.createElement('div')
        body.style.cssText = 'padding:9px 12px;color:#9e9480'
        body.textContent = d.phase ?? 'loading...'
        panel.appendChild(body)
        return panel
      }

      // Hero: base-type art (with a soft glow) + base name, like the main
      // overlay's item header. Greyed when the base wasn't recognised.
      const known = !!d.base && !d.base.startsWith('unknown')
      const hero = document.createElement('div')
      hero.style.cssText =
        'display:flex;align-items:center;gap:11px;padding:10px 12px;background:#23232e;border-bottom:1px solid rgba(56,56,77,0.5)'
      if (d.icon) {
        const iconWrap = document.createElement('div')
        iconWrap.style.cssText = 'position:relative;width:46px;height:46px;flex:0 0 auto;display:grid;place-items:center'
        const glow = document.createElement('img')
        glow.src = d.icon
        glow.alt = ''
        glow.style.cssText =
          'position:absolute;width:58px;height:58px;object-fit:contain;filter:blur(11px) saturate(1.6);opacity:0.55;pointer-events:none'
        const sharp = document.createElement('img')
        sharp.src = d.icon
        sharp.alt = ''
        sharp.style.cssText = 'position:relative;width:44px;height:44px;object-fit:contain;z-index:1'
        // Drop the whole icon (keep the name) if the CDN art fails to load.
        sharp.onerror = () => iconWrap.remove()
        iconWrap.append(glow, sharp)
        hero.appendChild(iconWrap)
      }
      const heroText = document.createElement('div')
      heroText.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px'
      const heroName = document.createElement('span')
      heroName.textContent = d.base ?? '(unknown)'
      heroName.style.cssText = `font-weight:700;font-size:15px;line-height:1.2;color:${known ? '#c8c8c8' : '#9e9480'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`
      const heroSub = document.createElement('span')
      heroSub.textContent = 'Desecrated Modifier'
      heroSub.style.cssText = 'font-size:11px;color:#9e9480;letter-spacing:0.03em'
      heroText.append(heroName, heroSub)
      hero.appendChild(heroText)
      panel.appendChild(hero)

      // Not-at-well / no-options note.
      if (d.note) {
        const note = document.createElement('div')
        note.style.cssText = 'padding:9px 12px;color:#9e9480;white-space:pre-wrap'
        note.textContent = d.note
        panel.appendChild(note)
        return panel
      }

      // Affix rows: a tier chip + the canonical title-cased affix, with a thin
      // centre-faded divider between rows (matches the trade item-result style).
      const rows = document.createElement('div')
      rows.style.cssText = 'padding:4px 0'
      d.mods.forEach((m, i) => {
        if (i > 0) {
          const sep = document.createElement('div')
          sep.style.cssText =
            'height:1px;margin:3px 0;background-image:linear-gradient(90deg,transparent,rgba(56,56,77,0.75) 18%,rgba(56,56,77,0.75) 82%,transparent)'
          rows.appendChild(sep)
        }
        const row = document.createElement('div')
        row.style.cssText = 'display:flex;align-items:center;gap:9px;padding:6px 12px'
        const chip = document.createElement('span')
        chip.textContent = m.tier
        chip.style.cssText = `flex:0 0 auto;min-width:30px;text-align:center;font-weight:700;font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(0,0,0,0.3);color:${m.top ? '#ffd24a' : '#cbd5e1'}`
        const label = document.createElement('span')
        label.textContent = m.text
        label.style.cssText = 'flex:1;min-width:0;font-size:12px;color:#e0d8cc'
        row.append(chip, label)
        rows.appendChild(row)
      })
      panel.appendChild(rows)
      return panel
    }

    const draw = (state: { items: Label[]; diag: Diag }) => {
      container.innerHTML = ''
      const panel = buildPanel(state.diag)
      container.appendChild(panel)
      // Report the panel as the interactive region: the host flips this overlay
      // clickable while the cursor is inside it (so the close button works), and
      // leaves it click-through everywhere else (tier badges still pass clicks
      // to the game). getBoundingClientRect is in this window's CSS px.
      const r = panel.getBoundingClientRect()
      ctx.setInteractiveRegion({ x: r.x, y: r.y, width: r.width, height: r.height })

      const left = columnLeft()
      for (const it of state.items) {
        const el = document.createElement('div')
        el.textContent = it.text
        el.style.cssText = `position:absolute;left:${left}px;top:${it.y}px;transform:translate(-50%,-50%);font:bold 15px sans-serif;color:${
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
          clearInteractive()
          container.innerHTML = ''
        }
      } else if (current && container.childElementCount === 0) {
        draw(current)
      }
    }

    const id = setInterval(tick, 250)
    return () => {
      clearInterval(id)
      clearInteractive()
    }
  })
}
