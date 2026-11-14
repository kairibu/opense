// ---------------------------------------------------------------------------
// Per-browser OpenSE preferences (plan-v5 §2.C1, decision D1): browser-only
// plugins receive no generic settings context (`context.settings` is a
// server-entry-only surface), so the `.sysml` chat-link claim lives in a
// localStorage preference — one per browser device, deliberately not a
// federated/host setting. Global enable/disable stays available via
// Settings → PI WEB plugins.
//
// The module is feature-checked AND guarded: node test contexts import it
// without a DOM, so every accessor guards `typeof localStorage` itself —
// and real browsers can still throw on storage access (SecurityError when
// cookies/site data are blocked, legacy Safari private mode), so each
// access is wrapped in try/catch. A throwing read degrades to the default
// "on" behavior, a throwing write is a no-op: the accessors never throw.
// ---------------------------------------------------------------------------

/** localStorage key of the `.sysml` chat-link claim preference (C1). */
const CLAIM_SYSML_LINKS_KEY = "opense.claimSysmlLinks";

/**
 * Whether OpenSE claims `.sysml` workspace file links (`fileOpenQuery`, C1).
 * Default ON: only the explicit off value `"0"` opts out — an absent,
 * unrecognized, or unreachable key all leave the claim active, and both a
 * storage-less environment (node) and a throwing storage access
 * (SecurityError) degrade to the default instead of throwing.
 */
export function openseClaimsSysmlLinks(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    return localStorage.getItem(CLAIM_SYSML_LINKS_KEY) !== "0";
  } catch {
    return true;
  }
}

/**
 * Set the `.sysml` chat-link claim preference (C1): writes `"1"`/`"0"`.
 * Missing storage → no-op; a throwing storage access (SecurityError) →
 * no-op — the read side keeps its default.
 */
export function setOpenseClaimsSysmlLinks(value: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(CLAIM_SYSML_LINKS_KEY, value ? "1" : "0");
  } catch {
    // Blocked storage (SecurityError): the read side keeps its default.
  }
}