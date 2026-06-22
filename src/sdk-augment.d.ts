// Forward-declares host context capabilities that Scalpel already provides but
// which the published @scalpelpoe/plugin-sdk types (0.7.0) do not yet carry:
//  - setInteractiveRegion (annotation overlays)
//  - prices (poe.ninja snapshot; same API the currency-exchange plugin uses)
// Remove each once the SDK republishes with it; the signatures here match the
// host exactly so declaration-merging stays clean. The empty export makes this
// file a module, so `declare module` AUGMENTS the SDK interface instead of
// replacing it (an ambient script would shadow it).
export {}

declare module '@scalpelpoe/plugin-sdk' {
  interface PriceEntry {
    name: string
    category: string
    chaosValue: number
    divineValue?: number
    graph?: (number | null)[]
  }
  interface PricesApi {
    getPrices(opts?: { category?: string }): Promise<{ prices: PriceEntry[]; updatedAt: number | null }>
    refresh(): Promise<void>
    onChange(handler: () => void): () => void
  }
  interface ScalpelPluginContext {
    setInteractiveRegion(rect: { x: number; y: number; width: number; height: number } | null): void
    readonly prices: PricesApi
  }
}
