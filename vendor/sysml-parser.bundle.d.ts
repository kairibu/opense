// ---------------------------------------------------------------------------
// Hand-written minimal type surface for the vendored sysml-parser browser
// bundle (generated asset, sibling declaration for
// sysml-parser.bundle.js).
//
// Provenance: the bundle is built from the sandbox sysml-parser repo
// (/home/kai/Projekte/sandbox/sysml-parser/src/index.ts, chevrotain 10.5.0
// bundled). Regenerate it, not this file: run `npm run build:browser` in the
// sysml-parser repo, then copy with `npm run vendor:sysml` in pi-web
//
// These declarations cover ONLY what the OpenSE plugin consumes, so they can
// drift from the real library. The authoritative declarations live in the
// sandbox repo's src/ modules (ast.ts, parse.ts, loader.ts, query.ts,
// resolve.ts) — update this file when the bundle is regenerated and the
// plugin's usage surface changes.
//
// Deliberately absent (per the v1 scope): loadModelFromDirectory (node-only,
// loader-fs.ts — not even exported by the bundle), the chevrotain CST types,
// and the CLI (cli.ts) surface.
// ---------------------------------------------------------------------------

// --- errors (small structural types; chevrotain is deliberately not
// --- imported here)
export interface LexingErrorLike {
  offset: number;
  line: number;
  column: number;
  length: number;
  message: string;
}

/** Minimal structural stand-in for a chevrotain token. */
export interface TokenLike {
  image: string;
  line?: number;
  column?: number;
  [key: string]: unknown;
}

export interface ParserErrorLike {
  name: string;
  message: string;
  token: TokenLike;
  [key: string]: unknown;
}

// --- AST core (permissive surface for kind-specific detail extraction)
/**
 * Any AST member. The declared fields are the shared subset; kind-specific
 * fields (name, type, from/to, text, members, …) are reachable through the
 * index signature, so outline/detail extraction works without a full AST
 * mirror.
 */
export interface Member {
  kind:
    | "doc"
    | "import"
    | "metadata"
    | "package"
    | "occurrence"
    | "action"
    | "part"
    | "item"
    | "port"
    | "interface"
    | "allocation"
    | "requirement"
    | "subject"
    | "assert"
    | "flow"
    | "succession"
    | "perform"
    | "ref"
    | "attribute"
    | "feature";
  name?: string;
  members?: Member[];
  [key: string]: unknown;
}

/** Root of the merged namespace tree (the model kind is the document root). */
export interface SysmlModel {
  kind: "model";
  members: Member[];
}

// --- single-file parse
export interface ParseResult {
  /** The parsed model as a plain JSON-serializable AST. */
  model: SysmlModel;
  /** Raw concrete syntax tree; unused by the plugin (kept as `unknown`). */
  cst: unknown;
  lexerErrors: LexingErrorLike[];
  parserErrors: ParserErrorLike[];
}

export function parseSysml(source: string): ParseResult;

// --- multi-file workspace
export interface SourceFile {
  /** Normalized path or URL identifying the file, e.g. "model/oa.sysml". */
  path: string;
  source: string;
}

export interface FileResult {
  path: string;
  result: ParseResult;
  /** True iff the parse threw before producing any AST (result is a placeholder). */
  crashed?: true;
}

export interface WorkspaceDiagnostic {
  severity: "error" | "warning";
  /** File the diagnostic originates from (if known). */
  path?: string;
  message: string;
}

export interface Workspace {
  /** Merged namespace tree (same-name packages merged recursively across files). */
  model: SysmlModel;
  /** Per-file parse results, in deterministic (sorted-path) order. */
  files: FileResult[];
  /** Provenance lookup: AST member -> file it was declared in. */
  originOf: (member: Member) => string | undefined;
  diagnostics: WorkspaceDiagnostic[];
  /** True iff no lexer/parser/merge errors occurred. */
  ok: boolean;
}

export function loadModel(files: SourceFile[]): Workspace;

// --- model index / query API
export interface ModelElement {
  /**
   * Unique within one result/workspace. Equals `qualifiedName` for named
   * elements; a synthetic <kind>-segment path for unnamed elements,
   * addressable via `byId` (only named elements are reachable via `get`).
   */
  id: string;
  /** SysML v2 qualified name; undefined for unnamed elements. */
  qualifiedName?: string;
  /** `id` of the enclosing element; undefined for top-level members. */
  parentId?: string;
  kind: Member["kind"];
  /** Raw (unquoted) element name, only when the kind has a non-empty name. */
  name?: string;
  /** The full AST node (includes nested `members` for container kinds). */
  member: Member;
}

/** Filter: one kind, several kinds, or undefined = all. */
export interface ElementFilter {
  kind?: Member["kind"] | Member["kind"][];
}

export interface ModelIndex {
  /** Document (DFS pre-order) order; unknown filter kinds yield an empty list. */
  list(filter?: ElementFilter): ModelElement[];
  /**
   * Look up one element by SysML v2 qualified name (quoted/unquoted `::`-
   * joined string, or an array of raw name segments); undefined if not found.
   * Unnamed elements are never returned.
   */
  get(qualifiedName: string | string[]): ModelElement | undefined;
  /**
   * Look up one element by its exact index id (named elements' qualified
   * name, unnamed elements' synthetic <kind> path, any `[n]` suffix kept);
   * matches verbatim only. Total: unknown ids/garbage yield undefined.
   * The only way to address unnamed elements.
   */
  byId(id: string): ModelElement | undefined;
  /**
   * Direct members of one container in document order, unnamed included;
   * `undefined` = top level. Total: unknown parent ids yield an empty list.
   */
  children(parentId: string | undefined): ModelElement[];
  /** Distinct element kinds present in the model, in first-seen order. */
  kinds(): Member["kind"][];
}

/** Accepts a ParseResult or any structurally compatible object carrying a `model`. */
export function createModelIndex(result: ParseResult | { model: SysmlModel }): ModelIndex;