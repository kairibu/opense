// ---------------------------------------------------------------------------
// OpenSE per-workspace reactive controller (plan §3.2): one
// `OpenseWorkspaceController` instance holds the complete UI state of one
// workspace's OpenSE panel — parse result, loading/stale/error flags, outline
// selection, kind filter, and the in-flight `parseRequest` reuse guard — and
// pushes every connected state mutation to the panel host via the CURRENT
// workspace context handle (`this.context.host.requestRender()`), gated on
// the controller's own connection flag.
//
// This is the formal `ReactiveController` the plan promotes the former
// `OpenseWorkspaceUiState` + LRU handling to. The per-workspace map and LRU
// eviction stay in the panel module (plan §6.1 default: the registry hands
// controller instances to elements via properties, no Context provider).
//
// Late-async-write guarding (plan §3.2): after every `await`, writes are
// dropped when `host.isConnected` is false — the `retained` flag's
// replacement. The connection flag is raised by `hostConnected()` (the
// panel's activity element drives it from its connect path), lowered by
// `hostDisconnected()` and by `release()` on LRU eviction, exactly like the
// former `retained = false`.
//
// lit is imported type-only: the module carries no runtime framework code, so
// the parse job it runs stays pure and the controller is unit-testable with a
// fake host, no DOM required (plan §5).
// ---------------------------------------------------------------------------

import type { ReactiveController } from "lit";
import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import type { Member } from "./vendor/sysml-parser.bundle.js";
import type { OutlineRow } from "./opense-contract.js";
import type { OpenseDiscoveryFiles } from "./opense-discovery.js";
import type { OpenseParseResult } from "./opense-panel.js";
import { namedOutlineKinds } from "./opense-outline.js";
import { formatUnknownError } from "./opense-shared.js";

/** One parse job: discovery walk → `loadModel` → `createModelIndex` →
 *  outline + report. Injected into the controller (rather than imported from
 *  the panel module) so this module has no runtime dependency on it and tests
 *  can substitute fakes for rejection/deferred-control cases. */
export type OpenseParseJob = (files: OpenseDiscoveryFiles) => Promise<OpenseParseResult>;

/** The connection flag the controller's late-async-write guards read. This
 *  is NOT structurally satisfied by a LitElement: the controller's own
 *  lifecycle methods (`hostConnected`/`hostDisconnected`/`release`) assign
 *  to `isConnected`, so the host must be a mutable flag holder — the panel
 *  module's private `OpensePanelHost`. (A real LitElement's `isConnected` is
 *  a read-only getter; the assignment would throw in strict mode.)
 *
 *  `isConnected` is read after every `await` point: false drops the write
 *  (disconnected panel or LRU-evicted workspace, §3.2). Render routing does
 *  not go through the host — the controller's `requestUpdate()` calls
 *  `this.context.host.requestRender()` on the CURRENT context handle, so
 *  re-renders always reach the workspace's fresh `files`/`host` snapshot. */
export interface OpenseWorkspaceHost {
  /** False once the workspace panel disconnects or the LRU evicts the
   *  workspace; late async writes (parse results landing afterwards) are
   *  dropped until the flag is raised again. */
  isConnected: boolean;
}

/**
 * One workspace's OpenSE panel state (the extracted `OpenseWorkspaceUiState`):
 * the fields the render functions read plus the mutations they call. Created
 * and owned by the panel module's per-workspace registry (`plan §6.1`), which
 * evicts instances over `OPENSE_WORKSPACE_STATE_LIMIT` and calls `release()`.
 *
 * `implements ReactiveController` is structural only: the panel drives the
 * lifecycle manually (deviation 3) — the activity element calls
 * `hostConnected()`/`hostDisconnected()` and the registry calls `release()`;
 * `addController()` is never invoked and the host is our flag holder, not a
 * lit-managed LitElement. Phase 3 elements must keep driving the controller
 * this way rather than assuming real Lit controller semantics.
 */
export class OpenseWorkspaceController implements ReactiveController {
  /** Connection flag for this workspace's panel (§3.2); the controller
   *  raises/lowers it from its lifecycle methods. */
  readonly host: OpenseWorkspaceHost;

  /** Workspace panel context. Refreshed by the registry on reuse — the host
   *  may hand out fresh `files` adapters between renders, and a re-parse must
   *  see the current one. */
  context: WorkspacePanelContext;

  /** Parse result (report + index + workspace); undefined until the first
   *  parse. The three fields are always assigned together at the end of a
   *  parse. */
  result: OpenseParseResult | undefined;

  loading = false;

  error: string | undefined;

  /** Set on onInvalidate; cleared when a fresh parse lands. */
  stale = false;

  /** Outline row id selected for the element-detail pane. */
  selectedId: string | undefined;

  /** Active kind filter; undefined = all kinds. */
  kindFilter: Member["kind"] | undefined;

  private readonly parseJob: OpenseParseJob;

  /** In-flight parse job; re-entrant calls reuse it (no overlapping jobs). */
  private parseRequest: Promise<void> | undefined;

  constructor(host: OpenseWorkspaceHost, context: WorkspacePanelContext, parseJob: OpenseParseJob) {
    this.host = host;
    this.context = context;
    this.parseJob = parseJob;
  }

  /** The workspace panel connected (the activity element calls this from its
   *  connect path). Marks the host connected and kicks the first parse;
   *  later parses reuse the in-flight job through the parseRequest guard, so
   *  overlapping jobs never run. */
  hostConnected(): void {
    this.host.isConnected = true;
    if (this.result === undefined && this.parseRequest === undefined) void this.parse();
  }

  /** The workspace panel disconnected: `isConnected` drops late async writes
   *  until the workspace reconnects (§3.2). */
  hostDisconnected(): void {
    this.host.isConnected = false;
  }

  /** LRU eviction release (§3.2): the workspace left the registry, so late
   *  async writes drop even if the element stayed connected. Terminal —
   *  re-rendering the workspace creates a fresh controller. */
  release(): void {
    this.host.isConnected = false;
  }

  /** Panel invalidation: re-run discovery + parse unconditionally for the
   *  connected workspace (browser-only plugin — no owned-workspace gate). */
  invalidate(): Promise<void> {
    this.stale = this.result !== undefined;
    this.requestUpdate();
    return this.parse();
  }

  parse(): Promise<void> {
    // The infinite-retry guard: re-entrant parses (Parse button spam,
    // invalidate during a run, workspace switch-back) join the running job
    // instead of stacking new ones.
    if (this.parseRequest !== undefined) return this.parseRequest;
    this.loading = true;
    this.error = undefined;
    this.requestUpdate();

    const request = this.parseJob(this.context.files)
      .then((result) => {
        if (!this.host.isConnected) return;
        // The outline renders named rows only, so the kind filter is built
        // from the named kinds (an all-unnamed kind could never match).
        const kinds = namedOutlineKinds(result.index);
        if (this.kindFilter !== undefined && !kinds.includes(this.kindFilter)) this.kindFilter = undefined;
        this.result = result;
        this.stale = false;
        this.error = undefined;
        // A re-parse may drop the selected element (file removed/edited);
        // clear the dangling selection the same way git clears vanished files.
        this.selectedId = selectionIn(result.report.outline, this.kindFilter, this.selectedId);
      })
      .catch((error: unknown) => {
        if (this.host.isConnected) this.error = formatUnknownError(error);
      })
      .finally(() => {
        if (this.parseRequest !== request) return;
        this.parseRequest = undefined;
        this.loading = false;
        this.requestUpdate();
      });
    this.parseRequest = request;
    return request;
  }

  selectRow(rowId: string): void {
    this.selectedId = rowId;
    this.requestUpdate();
  }

  setKindFilter(kind: Member["kind"] | undefined): void {
    this.kindFilter = kind;
    // A filtered-out selection would leave a dangling detail pane; drop it.
    if (this.result !== undefined) this.selectedId = selectionIn(this.result.report.outline, kind, this.selectedId);
    this.requestUpdate();
  }

  private requestUpdate(): void {
    // Route through the CURRENT context handle (refreshed by the registry on
    // workspace reuse, like the pre-refactor `state.context` refresh), so
    // re-renders reach the same fresh `host` snapshot the parse reads use.
    if (this.host.isConnected) this.context.host.requestRender();
  }
}

/**
 * Keep `selectedId` only when the row would still be rendered under the
 * current kind filter; the report carries the unfiltered outline.
 */
function selectionIn(outline: OutlineRow[], filter: Member["kind"] | undefined, selectedId: string | undefined): string | undefined {
  if (selectedId === undefined) return undefined;
  const visible = filter === undefined ? outline : outline.filter((row) => row.kind === filter);
  return visible.some((row) => row.id === selectedId) ? selectedId : undefined;
}