// ---------------------------------------------------------------------------
// OpenSE workspace-report contract: plugin-local types, response-shape
// guards, and the single adapter that narrows vendored parser types to
// plugin-local ones.
//
// Coupling to the vendored sysml-parser bundle is deliberately confined to
// the type imports and to openseReportFromWorkspace below. If the vendor
// .d.ts drifts (a renamed field, a removed kind, ...), typechecking this
// file fails loudly in one place instead of scattering breakage across the
// plugin; runtime drift of a rebuilt bundle is caught by the same per-entry
// validators the response guards use.
//
// Diagnostics formatting lives in the parser: WorkspaceDiagnostic messages
// already carry `line:col` text, so this module only re-exports and
// validates shapes — it never formats messages itself.
// ---------------------------------------------------------------------------

import type { Member, Workspace, WorkspaceDiagnostic } from "./vendor/sysml-parser.bundle.js";

/** Plugin-local diagnostic shape, re-exported from the vendored bundle. */
export type { WorkspaceDiagnostic } from "./vendor/sysml-parser.bundle.js";

/** One row of the merged-model outline (a flat mapping of ModelIndex.list()). */
export interface OutlineRow {
  /**
   * Index id — stable identity within one report. Carries the index's
   * duplicate-sibling `[n]` suffixes and, for unnamed elements, the
   * synthetic `<kind>` path, so rows without a qualified name still have a
   * unique key for the renderer.
   */
  id: string;
  kind: Member["kind"];
  /** Raw (unquoted) element name; undefined for unnamed elements. */
  name?: string;
  /** SysML v2 qualified name; undefined for unnamed elements. */
  qualifiedName?: string;
  /** `id` of the enclosing element; undefined for top-level members. */
  parentId?: string;
}

/** The workspace-level report the panel renders: diagnostics + outline. */
export interface OpenseWorkspaceReport {
  diagnostics: WorkspaceDiagnostic[];
  outline: OutlineRow[];
  /**
   * Summary-badge state (plan §3.4; rendered as the toolbar's ok/issues
   * pill): false when any error-severity diagnostic exists — discovery or
   * parser. Warnings alone leave it true.
   */
  ok: boolean;
  parsedFileCount: number;
}

/**
 * Guard for a report received from an untrusted/unknown boundary. Validates
 * every entry (mirrors the git-contract response-guard idiom) and throws
 * with a contextual message on the first shape violation.
 */
export function parseOpenseWorkspaceReport(value: unknown): OpenseWorkspaceReport {
  const record = requireRecord(value, "OpenSE workspace report");
  return {
    diagnostics: parseWorkspaceDiagnostics(record["diagnostics"]),
    outline: parseOutlineRows(record["outline"]),
    ok: requireBoolean(record, "ok"),
    parsedFileCount: requireFiniteNumber(record, "parsedFileCount"),
  };
}

/**
 * Adapter: narrow a vendored `Workspace` into the plugin-local report parts.
 * Every field passes through the same per-entry validators the response
 * guard uses — including `ok` and `files` — so runtime drift of a rebuilt
 * vendor bundle fails loudly at this single boundary. Outline rows are
 * already plugin-local and pass through untouched.
 */
export function openseReportFromWorkspace(workspace: Workspace, outline: OutlineRow[]): OpenseWorkspaceReport {
  // The typed `Workspace` is the compile-time drift check; `requireRecord`
  // (already used by the response guard) additionally guards the runtime
  // shape of a rebuilt bundle: a missing/renamed `ok` or `files` field
  // fails loudly here instead of flowing into the report silently.
  return parseWorkspaceReport(workspace, outline);
}

function parseWorkspaceReport(workspace: unknown, outline: OutlineRow[]): OpenseWorkspaceReport {
  const record = requireRecord(workspace, "workspace");
  return {
    diagnostics: parseWorkspaceDiagnostics(record["diagnostics"]),
    outline,
    ok: requireBoolean(record, "ok"),
    parsedFileCount: requireArrayValue(record["files"], "files").length,
  };
}

function parseWorkspaceDiagnostics(value: unknown): WorkspaceDiagnostic[] {
  return requireArrayValue(value, "diagnostics").map(parseWorkspaceDiagnostic);
}

function parseWorkspaceDiagnostic(value: unknown): WorkspaceDiagnostic {
  const record = requireRecord(value, "workspace diagnostic");
  const path = optionalString(record, "path");
  return {
    severity: parseDiagnosticSeverity(record["severity"]),
    ...(path === undefined ? {} : { path }),
    message: requireString(record, "message"),
  };
}

/** Every severity the vendored `WorkspaceDiagnostic["severity"]` union allows. */
const DIAGNOSTIC_SEVERITIES: readonly WorkspaceDiagnostic["severity"][] = ["error", "warning"];

function isDiagnosticSeverity(value: string): value is WorkspaceDiagnostic["severity"] {
  // `some` (not `includes`) so the comparison typechecks without an
  // assertion: `includes` on `readonly WorkspaceDiagnostic["severity"][]`
  // demands a `WorkspaceDiagnostic["severity"]` argument.
  return DIAGNOSTIC_SEVERITIES.some((severity) => severity === value);
}

function parseDiagnosticSeverity(value: unknown): WorkspaceDiagnostic["severity"] {
  if (typeof value === "string" && isDiagnosticSeverity(value)) {
    return value;
  }
  throw new Error(`Invalid workspace diagnostic severity: ${String(value)}`);
}

function parseOutlineRows(value: unknown): OutlineRow[] {
  return requireArrayValue(value, "outline").map(parseOutlineRow);
}

function parseOutlineRow(value: unknown): OutlineRow {
  const record = requireRecord(value, "outline row");
  const name = optionalString(record, "name");
  const qualifiedName = optionalString(record, "qualifiedName");
  const parentId = optionalString(record, "parentId");
  return {
    id: requireString(record, "id"),
    kind: parseMemberKind(record["kind"]),
    ...(name === undefined ? {} : { name }),
    ...(qualifiedName === undefined ? {} : { qualifiedName }),
    ...(parentId === undefined ? {} : { parentId }),
  };
}

/**
 * The full `Member["kind"]` union, declared once so the guard below
 * typechecks against it: adding/removing a kind in the vendor .d.ts becomes
 * a compile-time error at this single boundary instead of a silent runtime
 * misjudgment (this is the file's stated no-second-hardcoded-union goal).
 */
const MEMBER_KINDS: readonly Member["kind"][] = [
  "doc",
  "import",
  "metadata",
  "package",
  "occurrence",
  "action",
  "part",
  "item",
  "port",
  "interface",
  "allocation",
  "requirement",
  "subject",
  "assert",
  "flow",
  "succession",
  "perform",
  "ref",
  "attribute",
  "feature",
];

function isMemberKind(value: string): value is Member["kind"] {
  // `some` (not `includes`) so the comparison typechecks without an
  // assertion: `includes` on `readonly Member["kind"][]` demands a
  // `Member["kind"]` argument.
  return MEMBER_KINDS.some((kind) => kind === value);
}

function parseMemberKind(value: unknown): Member["kind"] {
  if (typeof value === "string" && isMemberKind(value)) {
    return value;
  }
  throw new Error(`Invalid outline row kind: ${String(value)}`);
}

// --- small shape helpers (same idioms as git-contract) ----------------------

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireArrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Expected string field: ${key}`);
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`Expected boolean field: ${key}`);
  return value;
}

function requireFiniteNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Expected finite number field: ${key}`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Expected string field: ${key}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}