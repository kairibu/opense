// ---------------------------------------------------------------------------
// Shared CSS fragments for the OpenSE Lit elements.
//
// Styles do not cross shadow roots, so declarations needed by more than one
// element (body, activity, palette) would otherwise be copy-pasted into each
// element's `static styles`. These composable `css` fragments are the single
// definition; elements interpolate them into their own rules via
// `static styles = [fragment, css`…`]`. Fragments are declaration-only
// (no selectors), so they compose inside any rule; differences between
// elements become small, explicit overrides instead of silently drifted
// copies.
//
// Importers must interpolate fragments only into static templates — never
// build CSS from runtime strings (no unsafeCSS).
// ---------------------------------------------------------------------------

import { css } from "lit";

/** Shared button core for the body element's toolbar/outline buttons and the
 *  action palette's buttons. The two elements deliberately differ in radius,
 *  background, text color, and padding — each element's own styles declare
 *  those four, so the drift stays visible as a decision. */
export const buttonBase = css`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--pi-border);
  cursor: pointer;
`;

/** Pill chrome (fully rounded, compact, small text) shared by the activity
 *  strip's stale/status chips and the body's kind filter, severity, and kind
 *  badge marks. */
export const pill = css`
  border-radius: 999px;
  padding: 1px 6px;
  font-size: 12px;
`;

/** Uppercase micro label used by kind labels and section headings. */
export const microLabel = css`
  color: var(--pi-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
`;

/** Single-line ellipsis truncation for names, previews, and headings. */
export const truncate = css`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;
