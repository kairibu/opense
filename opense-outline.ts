// ---------------------------------------------------------------------------
// Pure outline / element-detail helpers over the vendored parser's
// ModelIndex.
//
// These functions never import the bundle's runtime: they operate on an
// injected index and a workspace-shaped `originOf` lookup, so they stay pure
// over parser outputs and are testable with hand-built fixtures. All SysML
// v2 naming semantics (segment quoting, `[n]` sibling suffixes, `get()`
// normalization) come from the index itself — this module only maps and
// extracts.
// ---------------------------------------------------------------------------

import type {
  ElementFilter,
  Member,
  ModelElement,
  ModelIndex,
  Workspace,
} from "./vendor/sysml-parser.bundle.js";
import type { OutlineRow } from "./opense-contract.js";

/**
 * Distinct kinds of the NAMED elements present in the model, in first-seen
 * (document) order. The outline renders named rows only (unnamed elements
 * surface as owned members in the detail pane), so the kind filter is built
 * from this — a kind whose every element is unnamed (doc, import, …) would
 * otherwise offer a filter button that can never match a visible row.
 */
export function namedOutlineKinds(index: ModelIndex): Member["kind"][] {
  const kinds: Member["kind"][] = [];
  const seen = new Set<Member["kind"]>();
  for (const element of index.list()) {
    if (element.name === undefined || seen.has(element.kind)) continue;
    seen.add(element.kind);
    kinds.push(element.kind);
  }
  return kinds;
}

/**
 * Flat outline rows in document (DFS pre-order) order, mirroring
 * `index.list()`; the renderer derives nesting from `parentId`. The index's
 * duplicate-sibling `[n]` suffixes and the synthetic `<kind>` ids of unnamed
 * elements are preserved verbatim for stable row identity. An optional kind
 * filter passes straight through to the index.
 */
export function outlineRows(index: ModelIndex, filter?: ElementFilter): OutlineRow[] {
  return index.list(filter).map(toOutlineRow);
}

function toOutlineRow(element: ModelElement): OutlineRow {
  const name = element.name;
  const qualifiedName = element.qualifiedName;
  const parentId = element.parentId;
  return {
    id: element.id,
    kind: element.kind,
    ...(name === undefined ? {} : { name }),
    ...(qualifiedName === undefined ? {} : { qualifiedName }),
    ...(parentId === undefined ? {} : { parentId }),
  };
}

/** One curated kind-specific detail field of an element. */
export interface OpenseElementField {
  /** Raw member field key (stable, e.g. "type", "text"). */
  key: string;
  /** Human-readable label for the panel. */
  label: string;
  /** Rendered value: scalars verbatim, string arrays joined, unknown shapes skipped. */
  value: string;
}

/** One owned (direct child) element in the detail view. */
export interface OpenseOwnedElement {
  /** Index id — the selection key the panel navigates by. */
  id: string;
  kind: Member["kind"];
  /** Raw (unquoted) name; undefined for unnamed owned elements. */
  name?: string;
  /** Synthetic last id segment for unnamed rows, e.g. "<doc>" or "<doc>[2]". */
  syntheticLabel?: string;
  /** First line of a doc member's text, as a preview. */
  preview?: string;
}

/** Resolved element details for the selected outline row. */
export interface OpenseElementDetails {
  id: string;
  kind: Member["kind"];
  name?: string;
  qualifiedName?: string;
  /** Names of enclosing containers, outermost first (excludes the element itself). */
  parentChain: string[];
  /** File the element was declared in (workspace provenance); undefined when unknown. */
  declaringFile?: string;
  /** Curated kind-specific fields found on the member. */
  fields: OpenseElementField[];
  /** Direct members in document order, unnamed ones included. */
  owned: OpenseOwnedElement[];
}

/**
 * Resolve one element and extract what the detail view renders.
 *
 * A string `ref` is tried as an exact index id first (`byId`), which is the
 * only way unnamed elements (synthetic `<kind>` ids) are addressable; on a
 * miss it falls back to `get()`, so quoted, unquoted and mixed qualified-name
 * forms keep working. An array `ref` is a raw qualified-name segment list for
 * `get()`. A miss yields `undefined`.
 *
 * Field extraction is defensive: the vendored `Member` shape is permissive
 * (`[key: string]: unknown`), so only known scalar fields render and unknown
 * shapes are skipped without commentary.
 */
export function elementDetails(
  index: ModelIndex,
  workspace: Pick<Workspace, "originOf">,
  ref: string | string[],
): OpenseElementDetails | undefined {
  const element = (typeof ref === "string" ? index.byId(ref) : undefined) ?? index.get(ref);
  if (element === undefined) return undefined;
  const declaringFile = workspace.originOf(element.member);
  const name = element.name;
  const elementQualifiedName = element.qualifiedName;
  return {
    id: element.id,
    kind: element.kind,
    ...(name === undefined ? {} : { name }),
    ...(elementQualifiedName === undefined ? {} : { qualifiedName: elementQualifiedName }),
    parentChain: parentChain(index, element),
    ...(declaringFile === undefined ? {} : { declaringFile }),
    fields: memberFields(element.member),
    owned: index.children(element.id).map(toOwnedElement),
  };
}

function toOwnedElement(element: ModelElement): OpenseOwnedElement {
  const name = element.name;
  const text = element.member["text"];
  return {
    id: element.id,
    kind: element.kind,
    ...(name === undefined
      ? { syntheticLabel: lastSegment(element.id) }
      : { name }),
    ...(name === undefined && element.kind === "doc" && typeof text === "string" && text.trim().length > 0
      ? { preview: firstLine(text) }
      : {}),
  };
}

/** Everything after the last `::` of an id (ids never contain quoted `::`). */
function lastSegment(id: string): string {
  const at = id.lastIndexOf("::");
  return at === -1 ? id : id.slice(at + 2);
}

/** The first non-empty line of a doc text, trimmed to a short preview. */
function firstLine(text: string): string {
  const line = text.split("\n").map((entry) => entry.trim()).find((entry) => entry.length > 0) ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

/** Walk `parentId` links via `byId` to the root; defensively stops on a
 *  miss or a cycle. Unlike `get`, `byId` also resolves unnamed containers. */
function parentChain(index: ModelIndex, element: ModelElement): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let parentId = element.parentId;
  while (parentId !== undefined && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = index.byId(parentId);
    if (parent === undefined) break;
    chain.unshift(parent.name ?? parent.id);
    parentId = parent.parentId;
  }
  return chain;
}

/** Curated candidate member fields, in stable render order. */
const FIELD_KEYS: readonly (readonly [key: string, label: string])[] = [
  ["type", "Type"],
  ["id", "Id"],
  ["text", "Text"],
  ["target", "Target"],
  ["from", "From"],
  ["to", "To"],
  ["source", "Source"],
  ["keyword", "Keyword"],
  ["direction", "Direction"],
  ["multiplicity", "Multiplicity"],
  ["visibility", "Visibility"],
  ["shortName", "Short name"],
  ["value", "Value"],
  ["specializations", "Specializations"],
  ["isDefinition", "Definition"],
  ["properties", "Properties"],
];

function memberFields(member: Member): OpenseElementField[] {
  const fields: OpenseElementField[] = [];
  for (const [key, label] of FIELD_KEYS) {
    const value = serializeFieldValue(member[key]);
    if (value === undefined) continue;
    fields.push({ key, label, value });
  }
  return fields;
}

/**
 * Render a candidate member field to a display string. Accepts non-empty
 * strings, numbers, `true` booleans, non-empty string arrays, and the
 * metadata `Property[]` shape (`{ key, value }`); everything else (absent
 * keys, `false` booleans, empty arrays, nested objects/arrays, `members`)
 * is skipped.
 */
function serializeFieldValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  // Booleans render only when true: e.g. `isDefinition` on a `part def` is
  // salient, while the default `false` on every part usage would be noise.
  if (typeof value === "boolean") return value ? "true" : undefined;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value) && value.length > 0) {
    if (value.every((entry) => typeof entry === "string")) return value.join(", ");
    if (value.every(isPropertyRecord)) {
      return value.map((entry) => `${entry.key} = ${entry.value}`).join("; ");
    }
  }
  return undefined;
}

function isPropertyRecord(value: unknown): value is { key: string; value: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (
    "key" in value && typeof value.key === "string" && "value" in value && typeof value.value === "string"
  );
}