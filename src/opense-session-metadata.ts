// ---------------------------------------------------------------------------
// OpenSE public session metadata (plan-v5 §2.E E3, opendoor pattern — direct
// adaptation of opendoor's `src/doorstop-session-metadata.ts`): the namespaced
// `SessionUiMetadata` payload OpenSE publishes with a dispatched
// investigate/task session, and the tolerant parser the browser session-label
// contribution reads it back with.
//
// The host persists this payload verbatim as the public
// `pi-web.session-ui-metadata` custom entry (`version: 1`), so it survives
// reopen and archive, is readable without a live Pi connection, and older
// hosts simply omit the field (labels then render nothing).
//
// Discipline (mirrored from the opendoor module):
//   - STRICT BUILD (extension side): `buildOpenseSessionMetadata` validates
//     the op enum and the element list and THROWS on junk — the same
//     strictness as the shipped contract parsers, so a malformed payload can
//     never be persisted. It is the SINGLE validation source: neither the
//     dispatch extension nor the label introduces a second element grammar.
//   - TOLERANT PARSE (browser side): `parseOpenseSessionMetadata` NEVER
//     throws and returns `undefined` for absent/malformed/future-schema/
//     foreign data, so the session-label contribution degrades to nothing on
//     junk rows and older hosts.
//   - SECRETS POLICY: the payload carries ONLY the op enum and element
//     qualified names — identifiers already public in panel URLs, chat
//     references, and the UI. No model text, file contents, or settings.
//     Both sides additionally treat every element as untrusted before it can
//     reach a template or the host bridge.
//
// Element identity: the element grammar IS the C2/C4 qualified-name grammar
// (`isQualifiedOpenseName` from opense-references.ts — one shared grammar, so
// chat extraction, chip rendering, and session metadata cannot drift), plus
// the safe-token bound below. The label's reopen link passes the element in
// the W4a `element` query key, which the controller's C3 restore step
// resolves with `normalizedQualifiedName` — the same resolution chat deep
// links use.
//
// No host imports (only the pure opense-references module), so this module
// bundles into both the browser entry and the self-contained Pi extension.
// ---------------------------------------------------------------------------

import { isQualifiedOpenseName } from "./opense-references.js";

/** The public metadata namespace OpenSE publishes under. Matches the host's
 *  namespace pattern (`^[a-zA-Z0-9@][a-zA-Z0-9._:/@-]{0,127}$`). */
export const OPENSE_SESSION_METADATA_NAMESPACE = "opense";

/** The metadata payload version this slice writes; an unknown (future)
 *  schema parses to `undefined` so a newer writer cannot make the label
 *  render stale assumptions. */
export const OPENSE_SESSION_METADATA_SCHEMA = 1;

/** Element-list bound: exactly ONE element per dispatched session today
 *  (one investigate/task command addresses one element). The plan's 1..4
 *  growth stays a future slice — raising this bound or the schema is a
 *  coordinated change with the label renderer, never a silent one. */
export const OPENSE_SESSION_METADATA_MAX_ELEMENTS = 1;

/** Per-element length bound. Qualified names are short; 128 characters is
 *  the shared C2/C4 candidate ceiling headroom, far above real names. */
export const OPENSE_SESSION_METADATA_MAX_ELEMENT_LENGTH = 128;

/** The recognized op values for schema 1. Unlike opendoor's single-value
 *  first slice, BOTH values ship day one (E-D2′: investigate and task
 *  dispatch both publish metadata from the start). */
export type OpenseSessionMetadataOp = "investigate" | "task";

/** The validated, public OpenSE session-metadata payload. */
export interface OpenseSessionMetadata {
  readonly schema: typeof OPENSE_SESSION_METADATA_SCHEMA;
  readonly op: OpenseSessionMetadataOp;
  readonly elements: readonly string[];
}

const OPENSE_SESSION_METADATA_OPS = new Set<OpenseSessionMetadataOp>(["investigate", "task"]);

/** Safe-token rule on top of the qualified-name grammar: an element must be
 *  ONE whitespace-free, control-free token. The dispatch command parses the
 *  element as its first whitespace-delimited token, and the session name
 *  embeds it — both could not carry spaces or control characters. This makes
 *  quoted segment names with inner whitespace (`Tracker::'needs focus'`)
 *  unpublishable by construction; the dispatch reports that honestly instead
 *  of corrupting the prompt. */
const OPENSE_METADATA_UNSAFE_TOKEN_CHARACTERS = /[\s\u0000-\u001f\u007f]/u;

/** Whether `value` is an element this schema is willing to publish/render: a
 *  bounded, non-empty safe token that whole-parses as a qualified name. */
function isMetadataElement(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value.length <= OPENSE_SESSION_METADATA_MAX_ELEMENT_LENGTH &&
    !OPENSE_METADATA_UNSAFE_TOKEN_CHARACTERS.test(value) &&
    isQualifiedOpenseName(value)
  );
}

/**
 * Build one validated public OpenSE metadata payload (extension side, before
 * the bridge frame). Throws on junk: an unknown op, a non-array/empty/
 * oversized element list, or an element outside the safe-token +
 * qualified-name + length rule. The returned payload contains exactly the
 * three schema keys (secrets policy by construction), and the `elements`
 * array is a fresh copy so frozen/aliased inputs cannot leak aliases into
 * the persisted entry.
 */
export function buildOpenseSessionMetadata(
  op: OpenseSessionMetadataOp,
  elements: readonly string[],
): OpenseSessionMetadata {
  if (!OPENSE_SESSION_METADATA_OPS.has(op)) {
    throw new Error(`Unsupported OpenSE session metadata op: ${JSON.stringify(op)}`);
  }
  if (elements.length === 0 || elements.length > OPENSE_SESSION_METADATA_MAX_ELEMENTS) {
    throw new Error(
      `OpenSE session metadata requires 1..${String(OPENSE_SESSION_METADATA_MAX_ELEMENTS)} elements`,
    );
  }
  const copied: string[] = [];
  for (const element of elements) {
    if (!isMetadataElement(element)) {
      throw new Error(
        `Invalid OpenSE session metadata element (expected a whitespace-free qualified name of at most ` +
          `${String(OPENSE_SESSION_METADATA_MAX_ELEMENT_LENGTH)} characters)`,
      );
    }
    copied.push(element);
  }
  return {
    schema: OPENSE_SESSION_METADATA_SCHEMA,
    op,
    elements: copied,
  };
}

/**
 * Parse one untrusted `opense` namespace value (browser side). NEVER throws:
 * absent metadata, foreign namespaces, junk shapes, a future schema, an
 * unknown op, and out-of-rule elements all return `undefined` — the label
 * then renders nothing, which is the documented older-host/junk-row
 * tolerance. The returned payload is normalized to the three schema keys, so
 * extra keys persisted by a future/hostile writer never reach the label
 * renderer.
 */
export function parseOpenseSessionMetadata(value: unknown): OpenseSessionMetadata | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record["schema"] !== OPENSE_SESSION_METADATA_SCHEMA) return undefined;
  const op = record["op"];
  if (typeof op !== "string" || !OPENSE_SESSION_METADATA_OPS.has(op as OpenseSessionMetadataOp)) {
    return undefined;
  }
  const elementsValue = record["elements"];
  if (
    !Array.isArray(elementsValue) ||
    elementsValue.length === 0 ||
    elementsValue.length > OPENSE_SESSION_METADATA_MAX_ELEMENTS
  ) {
    return undefined;
  }
  const elements: string[] = [];
  for (const element of elementsValue) {
    if (!isMetadataElement(element)) return undefined;
    elements.push(element);
  }
  return {
    schema: OPENSE_SESSION_METADATA_SCHEMA,
    op: op as OpenseSessionMetadataOp,
    elements,
  };
}
