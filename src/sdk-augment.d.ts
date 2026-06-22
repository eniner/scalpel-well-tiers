// Forward-declares ctx.setInteractiveRegion, which Scalpel's host already
// provides to annotation overlays but which the published @scalpelpoe/plugin-sdk
// types (0.7.0) do not yet carry. Remove once the SDK republishes with it; the
// signature here matches the host exactly so declaration-merging stays clean.
// The empty export makes this file a module, so `declare module` AUGMENTS the
// SDK interface instead of replacing it (an ambient script would shadow it).
export {}

declare module '@scalpelpoe/plugin-sdk' {
  interface ScalpelPluginContext {
    setInteractiveRegion(rect: { x: number; y: number; width: number; height: number } | null): void
  }
}
