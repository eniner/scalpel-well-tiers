import type { ScalpelPluginContext } from '@scalpelpoe/plugin-sdk'

export default function activate(ctx: ScalpelPluginContext): void {
  ctx.registerHotkey({ label: 'Reveal well tiers' }, () => {
    ctx.log('well-tiers fired')
  })
}
