// ---------------------------------------------------------------------------
// C4 (plan-v5 §2.C, decision D3): the `[[Pkg::Wheel]]` markdown extension.
// The OpenSE reference chip renders as a non-interactive styled span —
// `<span class="opense-ref">Pkg::Wheel</span>` — a visual affordance for
// C2's message action, which detects the same syntax through the shared
// `parseOpenseChip` (opense-references.ts) so extraction and rendering
// cannot drift. There is deliberately NO click behavior: the host sanitizer
// strips links and handlers from extension output (§1), and inline code is
// a protected surface, which is why the chip syntax exists at all.
//
// Extension contract (MarkdownExtensionContribution, landed 1.202611.1):
// `start` reports the earliest possible `[[`; `tokenize` accepts ONLY a
// complete well-formed chip at the START of the source — anything else
// (invalid contents, truncated `[[Pkg::`, plain text) returns undefined so
// the host renders it as ordinary markdown; `render` returns deterministic
// escaped HTML (the host caches by exact raw token text, so identical raw
// must produce identical output).
//
// Pure data + functions (no DOM): kept out of opense-references.ts so that
// module stays free of plugin-API imports, and small enough to live here
// rather than enlarging the wiring in opense-panel.ts.
// ---------------------------------------------------------------------------

import type { MarkdownExtensionContribution, MarkdownExtensionToken } from "@jmfederico/pi-web/plugin-api";
import { parseOpenseChip } from "./opense-references.js";

/** The C4 markdown extension (contribution id `opense-refs`, inline level). */
export const openseReferenceChipExtension: MarkdownExtensionContribution = {
  id: "opense-refs",
  level: "inline",
  start: (source: string): number | undefined => {
    const at = source.indexOf("[[");
    return at === -1 ? undefined : at;
  },
  // Only complete well-formed chips at the start of source are consumed;
  // invalid or truncated contents fall through to the host's own parser.
  tokenize: (source: string): MarkdownExtensionToken | undefined => {
    const chip = parseOpenseChip(source);
    if (chip === undefined) return undefined;
    return { raw: chip.raw, text: chip.name };
  },
  // Deterministic string HTML; the name is untrusted chat text, so the five
  // HTML-significant characters are escaped here even though the host
  // sanitizer runs afterwards.
  render: (token: Readonly<MarkdownExtensionToken>): string =>
    `<span class="opense-ref">${escapeOpenseChipHtml(token.text)}</span>`,
};

/** Escape the HTML-significant characters of an (untrusted) chip name. */
export function escapeOpenseChipHtml(value: string): string {
  // The ampersand of each entity is written as \u0026 so this source
  // file itself stays free of literal HTML-entity sequences.
  return value
    .replace(/&/g, "\u0026amp;")
    .replace(/</g, "\u0026lt;")
    .replace(/>/g, "\u0026gt;")
    .replace(/"/g, "\u0026quot;")
    .replace(/'/g, "\u0026#39;");
}
