// ---------------------------------------------------------------------------
// Pure extraction of OpenSE element references from chat text (plan-v5 §2.C
// C2, decision D2). Two conventions qualify, both deliberately conservative:
//
//  - Backticked inline code spans (`` `Pkg::Wheel` ``): D2's original
//    convention — agents already write SysML names this way, and inline code
//    is a protected markdown surface (§1), so nothing else can claim it.
//  - `[[Pkg::Wheel]]` chip syntax (C4/D3): the syntax exists precisely
//    BECAUSE inline code cannot be styled by extensions; C2 detects both
//    forms so every rendered chip is also actionable.
//
// Grammar (conservative, aligned with the vendored parser's lexer —
// sysml-parser.bundle.js src/lexer.ts, `Identifier`/`QuotedName` tokens):
// a span's WHOLE content must parse as a qualified name — trimmed overall,
// `::`-separated, at least TWO segments, the first segment package-style
// (unquoted `^[A-Za-z_][A-Za-z0-9_]*$`), every other segment either an
// unquoted identifier or a quoted `'...'` segment (non-empty, no `'`
// inside — the lexer's `QuotedName` is `/'[^']*'/`). Quoted segments cannot
// contain `::` either: the candidate is split on `::` first, so a `::`
// inside quotes breaks the segment and the pieces then fail both segment
// shapes — conservative by construction.
//
// Decision on `std::vector`-shaped spans (documented, no case heuristics):
// two valid unquoted identifiers with a package-style first segment qualify
// GRAMMATICALLY — the plan's "excluded by the grammar" note overshoots, and
// inventing case rules (`^[A-Z]` first segments) would reject lowercase
// package names that are perfectly legal SysML. The cost of the false
// positive is one navigation that lands on C3's honest "'X' was not found
// in the current model" notice — cheap and truthful; a case heuristic would
// be neither predictable nor documented in the SysML spec.
//
// Fenced code blocks (``` and ~~~, matching CommonMark fence rules —
// 0–3 leading spaces, opening run of 3+, closing fence of equal character
// and at least equal length, backtick fences carry no backtick in their
// info string) are stripped before scanning, so model snippets never
// produce candidates. Inline backslash-escaped backticks are not span
// openers. Results dedupe, keep first-appearance order, and cap at
// OPENSE_REFERENCE_CANDIDATE_LIMIT.
//
// Known gap (documented, deliberate): four-space/tab-INDENTED code blocks
// are NOT stripped — only fenced blocks are. Indented code is a protected
// host surface, so a backticked reference inside one still yields a
// candidate whose navigation lands on C3's honest "'X' was not found in
// the current model" notice; acceptable and documented here rather than
// guessed at with content heuristics.
//
// Pure module (mirrors opense-outline.ts): no DOM, no plugin-API imports —
// only string scanning — so it is testable in node and bundles anywhere.
// The chip half of the grammar lives here as `parseOpenseChip` so C2's
// extraction and C4's tokenizer share ONE parser and cannot drift.
// `isDispatchableOpenseSubject` is the dispatch-side single-token rule the
// prompt composers check before composing a `/opense-…` command line.
// ---------------------------------------------------------------------------

/** Maximum number of candidates `openseReferenceCandidates` returns. */
export const OPENSE_REFERENCE_CANDIDATE_LIMIT = 50;

/** Unquoted SysML identifier segment (lexer `Identifier`:
 *  `[A-Za-z_][A-Za-z0-9_]*`). */
const UNQUOTED_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Quoted name segment (lexer `QuotedName` minus the empty quote):
 *  non-empty content, no quote character inside. */
const QUOTED_SEGMENT = /^'[^']+'$/;

/** One parsed `[[Qualified::Name]]` chip: the validated qualified name and
 *  the exact source text the chip occupies (`[[` … `]]` inclusive). */
export interface OpenseChip {
  readonly name: string;
  readonly raw: string;
}

/**
 * Parse a complete, well-formed `[[Qualified::Name]]` chip at the START of
 * `source`. Returns undefined unless `source` begins with `[[` and the text
 * up to the FIRST `]]` (exclusive) whole-parses as a qualified name — the
 * shared parser behind both C2's extraction and C4's markdown tokenizer.
 * `raw` covers only the chip, so `source` may continue past it. Invalid or
 * truncated contents yield undefined (the caller must not consume them).
 */
export function parseOpenseChip(source: string): OpenseChip | undefined {
  if (!source.startsWith("[[")) return undefined;
  const close = source.indexOf("]]");
  if (close < 2) return undefined;
  const content = source.slice(2, close);
  if (!isQualifiedOpenseName(content)) return undefined;
  return { name: content.trim(), raw: source.slice(0, close + 2) };
}

/**
 * Does the WHOLE text parse as an OpenSE qualified-name candidate?
 * Conservative shape (see the module header): trimmed overall, `::`-split,
 * ≥ 2 segments, first segment an unquoted package-style identifier, every
 * other segment an unquoted identifier or a quoted `'...'` segment.
 */
export function isQualifiedOpenseName(text: string): boolean {
  const trimmed = text.trim();
  const segments = trimmed.split("::");
  if (segments.length < 2) return false;
  if (!UNQUOTED_IDENTIFIER.test(segments[0] ?? "")) return false;
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    if (UNQUOTED_IDENTIFIER.test(segment)) continue;
    if (QUOTED_SEGMENT.test(segment)) continue;
    return false;
  }
  return true;
}

/** Any whitespace character: the extension's command parse splits the
 *  element off as the FIRST whitespace-delimited token, so whitespace is
 *  the one character class a composed command line cannot carry. */
const WHITESPACE = /\s/u;

/**
 * Can a palette element subject ride a composed `/opense-…` dispatch
 * command line as the element? The extension's parse rule takes the FIRST
 * whitespace-delimited token after the command name as the element, so only
 * a WHITESPACE-FREE subject round-trips: a subject whose quoted segment
 * carries an inner space (`Tracker::'needs focus'`) would truncate at the
 * space, and the strict session-metadata builder would refuse the fragment
 * — the dispatch would report an invalid element and start nothing. The
 * prompt composers check this and keep such a subject on the bare
 * instruction (the inline fallback survives in the current session), so
 * the quoted-name limitation applies only to a MANUALLY typed command.
 * Pure by construction: one string scan, no grammar beyond whitespace —
 * the builder's remaining rules (qualified-name shape, length bound)
 * still apply at dispatch time.
 */
export function isDispatchableOpenseSubject(subject: string): boolean {
  return subject !== "" && !WHITESPACE.test(subject);
}

/**
 * Extract qualified-name candidates from chat text (plan-v5 §2.C C2, D2):
 * backticked inline code spans plus `[[...]]` chips, deduped, in order of
 * first appearance, capped at OPENSE_REFERENCE_CANDIDATE_LIMIT. Fenced code
 * blocks are stripped first; a span/chip qualifies only when its whole
 * content parses as a qualified name.
 */
export function openseReferenceCandidates(text: string): string[] {
  const scan = stripFencedCode(text);
  const candidates: string[] = [];
  const seen = new Set<string>();
  let index = 0;
  while (index < scan.length) {
    const char = scan.charAt(index);
    // Inline backslash escape: the next character is literal, so an escaped
    // backtick never opens a code span.
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "`") {
      const close = scan.indexOf("`", index + 1);
      // Unclosed backtick: literal text, no span — keep scanning past it so
      // later chips/spans still count.
      if (close === -1) {
        index += 1;
        continue;
      }
      // A span qualifies ONLY if its whole content parses as a qualified
      // name; anything else is ordinary inline code, not a reference.
      const span = scan.slice(index + 1, close);
      if (isQualifiedOpenseName(span)) addCandidate(candidates, seen, span);
      index = close + 1;
      continue;
    }
    if (scan.startsWith("[[", index)) {
      const chip = parseOpenseChip(scan.slice(index));
      if (chip !== undefined) {
        addCandidate(candidates, seen, chip.name);
        index += chip.raw.length;
      } else {
        // Not a chip: advance ONE character, not past both brackets — the
        // host's markdown engine retries inline tokenizers at offset+1
        // after a failed start (marked), so `[[[Pkg::Wheel]]]` renders a
        // chip from offset 1 and detection must scan the same offsets or
        // the action hides a rendered chip. A backtick inside the skipped
        // text still opens a legitimate later span.
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return candidates.slice(0, OPENSE_REFERENCE_CANDIDATE_LIMIT);
}

/**
 * Chooser/palette row label for one candidate. The candidate itself is the
 * most honest label (it is the exact text that will be resolved and shown
 * in the not-found notice when it misses), so this is the identity function
 * today — kept as a named export so the chooser rows have one place to gain
 * richer labels later.
 */
export function openseReferenceLabel(candidate: string): string {
  return candidate;
}

function addCandidate(candidates: string[], seen: Set<string>, candidate: string): void {
  const name = candidate.trim();
  if (seen.has(name)) return;
  seen.add(name);
  candidates.push(name);
}

/** One fenced block's delimiter: character and opening run length. */
interface Fence {
  readonly marker: string;
  readonly length: number;
}

/**
 * Replace fenced code blocks with nothing so their contents never produce
 * candidates (fences may legitimately contain prose-shaped qualified names
 * in model snippets). CommonMark fence shape: 0–3 leading spaces, a run of
 * 3+ backticks or tildes, a closing fence of the same character and at least
 * the opening length; a backtick fence's info string must not contain a
 * backtick. An unclosed fence swallows the rest of the text.
 */
function stripFencedCode(text: string): string {
  const kept: string[] = [];
  let fence: Fence | undefined;
  for (const line of text.split("\n")) {
    if (fence !== undefined) {
      if (isClosingFence(line, fence)) fence = undefined;
      continue;
    }
    const opened = openingFence(line);
    if (opened !== undefined) {
      fence = opened;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function openingFence(line: string): Fence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null) return undefined;
  const fence = match[1] ?? "";
  const info = match[2] ?? "";
  if (fence.startsWith("`") && info.includes("`")) return undefined;
  return { marker: fence.charAt(0), length: fence.length };
}

function isClosingFence(line: string, fence: Fence): boolean {
  return new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`).test(line);
}
