import type { GameCapture, ScalpelPluginContext } from '@scalpelpoe/plugin-sdk'
import { baseIconUrl, buildTierMap } from './dataset'
import { detectBaseType, nearestBase } from './detect'
import { extractOptions, findOptionsBoundary } from './match'
import { ocrRegion, setOcrProgress, warmWorkers } from './ocr'
import type { Line } from './segment'
import { readRewardRows } from './row-read'
import {
  buildPriceIndex,
  diagnoseCandidates,
  type Candidate,
  type PricedReward,
  priceRewards,
} from './rewards'
import { canonicalRewardCount } from './rewards-catalog'
import { SCALPEL_ICON } from './scalpel-icon'

// Which supported screen this fire is for - selects the render path.
type Mode = 'well' | 'runeshape'

interface Label {
  // Absolute CSS-px column for the label. Well tier badges omit it (the render
  // derives the column from the well centre); reward prices set it per the
  // panel, computed from the OCR row boxes in the handler.
  x?: number
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
  // Runeshape-only status line field.
  updatedAt?: number | null
  // Runeshape OCR/pricing trace (shown in the debug panel).
  debug?: string | null
}
interface Fire {
  token: string
  firedAt: number
  open: boolean
  mode: Mode
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
// Status pill (poe.ninja + freshness) anchor, in the panel header - fractions of
// game HEIGHT from the top-left, so it tracks the header across resolutions.
const STATUS_LEFT_FRAC = 0.39
const STATUS_TOP_FRAC = 0.1
// Runeshape price column, as a fraction of game HEIGHT from the screen's LEFT
// edge (the panel is left-mounted and PoE UI scales with height, so this holds
// across resolutions). Tuned in-game.
const RS_PRICE_X_FRAC = 0.503
const EMPTY_DIAG: Diag = { loading: false, base: null, mods: [], note: null }

const formatRuneshapeDebug = (
  method: string,
  rowLines: Line[],
  candidates: Candidate[],
  index: ReturnType<typeof buildPriceIndex>,
  pricedCount: number,
  priceCount: number,
): string => {
  const parts: string[] = []
  parts.push(`reader: ${method}`)
  parts.push(`poe.ninja entries: ${priceCount} (catalog: ${canonicalRewardCount()} names)`)
  parts.push(`Rows read:`)
  for (const l of rowLines) {
    const t = l.text.replace(/\s+/g, ' ').trim()
    if (!t) continue
    parts.push(`  y=${Math.round(l.box.y).toString().padStart(3)} "${t}"`)
  }
  parts.push('')
  parts.push(`Candidates (${candidates.length}) -> badges (${pricedCount}):`)
  for (const d of diagnoseCandidates(candidates, index)) {
    const flag = d.explicit ? 'Nx' : '  '
    const badge = d.badge ?? '—'
    parts.push(`  [${flag}] y=${String(d.y).padStart(3)} ${d.qty}x ${d.name}`)
    parts.push(`       ${d.outcome} ${badge} | ${d.detail}`)
  }
  return parts.join('\n')
}

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

const setFire = (ctx: ScalpelPluginContext, open: boolean, mode: Mode, items: Label[], diag: Diag): Promise<void> =>
  ctx.storage.set('lastFire', { token: String(Date.now()), firedAt: Date.now(), open, mode, items, diag } satisfies Fire)

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

/** Read the Runeshape Combinations panel, price each "Nx <Item>" reward off the
 *  host poe.ninja snapshot, and write inline price labels + a status line. `step`
 *  feeds the OCR progress sink's phase label; `pushPhase` writes the loading line. */
async function priceRuneshapeRewards(
  ctx: ScalpelPluginContext,
  frame: GameCapture,
  pushPhase: (text: string) => void,
  setStep: (text: string) => void,
): Promise<void> {
  setStep('Reading rewards')
  pushPhase('Reading rewards...')

  const { lines: rowLines, candidates, method } = await readRewardRows(frame, (row, total) => {
    pushPhase(`Reading row ${row}/${total}...`)
  })

  setStep('Pricing rewards')
  pushPhase('Pricing rewards...')
  let priced: PricedReward[] = []
  let updatedAt: number | null = null
  let priceIndex = buildPriceIndex([])
  let priceCount = 0
  try {
    const [all, cur, runes, uncut] = await Promise.all([
      ctx.prices.getPrices(),
      ctx.prices.getPrices({ category: 'currency' }),
      ctx.prices.getPrices({ category: 'runes' }),
      ctx.prices.getPrices({ category: 'uncut-gems' }),
    ])
    updatedAt = all.updatedAt ?? cur.updatedAt ?? runes.updatedAt ?? uncut.updatedAt
    const merged = [...all.prices, ...cur.prices, ...runes.prices, ...uncut.prices]
    priceCount = merged.length
    priceIndex = buildPriceIndex(merged)
    priced = priceRewards(candidates, priceIndex)
  } catch (e) {
    ctx.log(`well-tiers: price fetch failed (${e instanceof Error ? e.message : String(e)})`)
    priced = priceRewards(candidates, priceIndex)
  }

  const debug = formatRuneshapeDebug(method, rowLines, candidates, priceIndex, priced.length, priceCount)
  ctx.log(`well-tiers: runeshape debug\n${debug}`)

  if (candidates.length === 0) {
    const sample = rowLines
      .map((l) => l.text.trim())
      .filter(Boolean)
      .slice(0, 16)
      .join('\n')
    ctx.log(`well-tiers: no supported screen detected. Read: ${sample.replace(/\n/g, ' | ')}`)
    await setFire(ctx, true, 'well', [], {
      loading: false,
      base: null,
      mods: [],
      note: `Not at a supported screen.\n\nScanned text:\n${sample || '(no text read)'}`,
      debug,
    })
    return
  }

  const maxVal = priced.reduce((m, p) => (p.value != null && p.value > m ? p.value : m), 0)
  // Only the per-row Y comes from the OCR box; the X column is a single
  // left-anchored value applied (and tuned) in the overlay render.
  const items: Label[] = priced.map((p) => ({
    y: frame.origin.y + (p.box.y + p.box.h / 2) / frame.scale,
    text: p.text,
    top: maxVal > 0 && p.value === maxVal,
  }))
  await setFire(ctx, true, 'runeshape', items, {
    loading: false,
    base: null,
    mods: [],
    note: items.length ? null : 'No rewards read',
    updatedAt,
    debug,
  })
  ctx.log(`well-tiers: runeshape, ${items.length} rewards priced`)
}

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
      await setFire(ctx, false, 'well', [], EMPTY_DIAG)
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
    // Selected once the scout classifies the screen; loading writes before that
    // default to 'well'. Captured by pushPhase so each phase write tags the
    // right render path.
    let mode: Mode = 'well'
    let lastPhaseWrite = 0
    let lastPhaseText = ''
    const pushPhase = (text: string): void => {
      const now = Date.now()
      if (text === lastPhaseText && now - lastPhaseWrite < 150) return
      lastPhaseText = text
      lastPhaseWrite = now
      void setFire(ctx, true, mode, [], { loading: true, base: null, mods: [], note: null, phase: text })
    }
    setOcrProgress((status, progress) => {
      const label = prettyStatus(status, step)
      const pct = Math.round(progress * 100)
      pushPhase(pct > 0 && pct < 100 ? `${label}... ${pct}%` : `${label}...`)
    })
    try {
      await setFire(ctx, true, 'well', [], { loading: true, base: null, mods: [], note: null, phase: 'Scanning screen...' })
      ctx.openOverlay()

      const leftW = frame.width * 0.72
      // 'sparse' mode + a lower target width: the scout only needs to locate the
      // well's hint/confirm tokens, so it skips full layout analysis over this
      // big region. (The Runeshape screen is handled off its own high-res read.)
      const scout = await ocrRegion(frame, { x: 0, y: 0, w: leftW, h: frame.height }, SCOUT_W, 'sparse')
      const hintY = findOptionsBoundary(scout.lines)

      // Not the Well of Souls -> try the Runeshape Combinations panel. The helper
      // does a dedicated high-res read and self-detects (showing the diagnostic
      // readout itself if nothing prices), so the low-res scout never has to read
      // the small reward text or the header.
      if (hintY == null) {
        mode = 'runeshape'
        await priceRuneshapeRewards(ctx, frame, pushPhase, (text) => {
          step = text
        })
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
      await setFire(ctx, true, 'well', items, { loading: false, base: baseLabel, icon: baseIcon, mods, note: mods.length ? null : 'No options read' })
      ctx.log(`well-tiers: base=${base ?? 'unknown'}, ${items.length} tiers`)
    } finally {
      setOcrProgress(null)
      busy = false
    }
  })

  ctx.registerOverlay({ mode: 'annotation', title: 'Scalpel OCR' }, (container) => {
    let drawnToken = ''
    let current: { items: Label[]; diag: Diag; mode: Mode } | null = null

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
      void setFire(ctx, false, 'well', [], EMPTY_DIAG)
      ctx.closeOverlay()
    }

    // "4m ago" relative time for the reward price freshness line.
    const agoText = (ts: number): string => {
      const mins = Math.max(0, Math.round((Date.now() - ts) / 60000))
      if (mins < 1) return 'just now'
      if (mins < 60) return `${mins}m ago`
      return `${Math.round(mins / 60)}h ago`
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

    // Runeshape rewards: inline price labels next to each row + a small status
    // pill. No chrome panel (it would cover the game's own panel), so the overlay
    // stays fully click-through and the hotkey is the only way to dismiss it.
    const drawRuneshape = (state: { items: Label[]; diag: Diag }) => {
      clearInteractive()
      const d = state.diag

      // Price labels all share the left-anchored column (a fraction of the game
      // height, tuned in-game); only Y comes from each row's OCR box.
      const colX = Math.round(window.innerHeight * RS_PRICE_X_FRAC)
      for (const it of state.items) {
        const el = document.createElement('div')
        el.textContent = it.text
        el.style.cssText = `position:absolute;left:${colX}px;top:${it.y}px;transform:translateY(-50%);font:bold 14px sans-serif;color:${
          it.top ? '#ffd24a' : '#e2e8f0'
        };background:rgba(0,0,0,0.82);padding:1px 7px;border-radius:3px;white-space:nowrap;pointer-events:none`
        container.appendChild(el)
      }

      // Anchor the pill in the panel header (height-fraction from top-left), so it
      // sits in the empty space beside the "Runeshape Combinations" title and
      // doesn't move between the loading and result states.
      const pillLeft = window.innerHeight * STATUS_LEFT_FRAC
      const pillTop = window.innerHeight * STATUS_TOP_FRAC
      const pill = document.createElement('div')
      pill.style.cssText = `position:absolute;left:${pillLeft.toFixed(0)}px;top:${pillTop.toFixed(0)}px;padding:4px 10px;background:rgba(23,24,33,0.96);border:1px solid rgba(56,56,77,0.5);border-radius:8px;color:#9e9480;font:11px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.5);pointer-events:none;white-space:nowrap`
      if (d.loading) pill.textContent = d.phase ?? 'Scanning...'
      else if (d.note) pill.textContent = d.note
      else {
        const parts = ['poe.ninja']
        if (d.updatedAt) parts.push(agoText(d.updatedAt))
        pill.textContent = parts.join(' · ')
      }
      container.appendChild(pill)

      if (d.debug) {
        const dbg = document.createElement('div')
        dbg.style.cssText =
          'position:absolute;right:12px;bottom:12px;max-width:min(520px,42vw);max-height:45vh;overflow:auto;padding:10px 12px;background:rgba(12,12,18,0.94);border:1px solid rgba(198,169,110,0.35);border-radius:8px;color:#c8d0dc;font:11px/1.4 ui-monospace,Consolas,monospace;white-space:pre-wrap;pointer-events:auto;box-shadow:0 4px 20px rgba(0,0,0,0.6)'
        const title = document.createElement('div')
        title.textContent = 'Runeshape debug'
        title.style.cssText = 'color:#c8a96e;font-weight:700;margin-bottom:6px;font-family:system-ui,sans-serif;font-size:12px'
        const body = document.createElement('div')
        body.textContent = d.debug
        dbg.append(title, body)
        container.appendChild(dbg)
        const r = dbg.getBoundingClientRect()
        ctx.setInteractiveRegion({ x: r.x, y: r.y, width: r.width, height: r.height })
      }
    }

    const draw = (state: { items: Label[]; diag: Diag; mode: Mode }) => {
      container.innerHTML = ''
      if (state.mode === 'runeshape') {
        drawRuneshape(state)
        return
      }
      const panel = buildPanel(state.diag)
      container.appendChild(panel)
      // Report the panel as the interactive region: the host flips this overlay
      // clickable while the cursor is inside it (so the close button works), and
      // leaves it click-through everywhere else (tier badges still pass clicks
      // to the game). getBoundingClientRect is in this window's CSS px.
      const r = panel.getBoundingClientRect()
      ctx.setInteractiveRegion({ x: r.x, y: r.y, width: r.width, height: r.height })

      for (const it of state.items) {
        const el = document.createElement('div')
        el.textContent = it.text
        el.style.cssText = `position:absolute;left:${it.x ?? columnLeft()}px;top:${it.y}px;transform:translate(-50%,-50%);font:bold 15px sans-serif;color:${
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
          current = { items: r.items, diag: r.diag, mode: r.mode }
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
