// ---------------------------------------------------------------------------
// Small helpers shared across the OpenSE modules. Deliberately dependency-free
// (no plugin API, no parser, no DOM assumptions beyond feature checks) so every
// module can import it without cycles.
// ---------------------------------------------------------------------------

/** Format an unknown thrown value for a user-facing message. */
export function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Register a custom element exactly once. No-ops outside a DOM environment
 * (node-side tests import modules that define elements) and on re-registration
 * (plugin modules can be evaluated more than once across reloads). The
 * `define` callback is only invoked when registration actually happens, so
 * `class … extends HTMLElement` declarations inside it stay DOM-environment-safe.
 */
export function defineCustomElementOnce(tag: string, define: () => void): void {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") return;
  if (customElements.get(tag) !== undefined) return;
  define();
}
