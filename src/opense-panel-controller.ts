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
import type { WorkspaceInvalidation, WorkspacePanelContext, WorkspacePanelNavigationV1 } from "@jmfederico/pi-web/plugin-api";
import type { Member } from "./vendor/sysml-parser.bundle.js";
import type { OutlineRow } from "./opense-contract.js";
import type { OpenseDiscoveryFiles, OpenseDiscoveryRequestOptions } from "./opense-discovery.js";
import type { OpenseParseResult } from "./opense-panel.js";
import { namedOutlineKinds } from "./opense-outline.js";
import { formatUnknownError } from "./opense-shared.js";

/** Trailing-edge invalidation debounce (W1): mutation / agent-activity bursts
 *  within this window coalesce into exactly one parse. A named export so tests
 *  can advance fake timers by the real value instead of duplicating it. */
export const INVALIDATION_DEBOUNCE_MS = 500;

/** One parse job: discovery walk → `loadModel` → `createModelIndex` →
 *  outline + report. Injected into the controller (rather than imported from
 *  the panel module) so this module has no runtime dependency on it and tests
 *  can substitute fakes for rejection/deferred-control cases. `options` (W3)
 *  carries the run's AbortSignal to capability-v1 file adapters. */
export type OpenseParseJob = (files: OpenseDiscoveryFiles, options?: OpenseDiscoveryRequestOptions) => Promise<OpenseParseResult>;

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

  /** Abort handle of the in-flight parse run (W3); aborted on
   *  hostDisconnected/release so capability-v1 reads stop early. */
  private abortController: AbortController | undefined;

  /** Trailing-edge timer for debounced (mutation/agent-activity) invalidations. */
  private invalidationTimer: ReturnType<typeof setTimeout> | undefined;

  /** Resolvers of the promises returned by debounced `invalidate` calls; they
   *  settle after the coalesced parse the timer scheduled, or immediately when
   *  the pending debounce is cancelled (manual parse/release/disconnect). */
  private invalidationWaiters: Array<() => void> = [];

  constructor(host: OpenseWorkspaceHost, context: WorkspacePanelContext, parseJob: OpenseParseJob) {
    this.host = host;
    this.context = context;
    this.parseJob = parseJob;
  }

  /** The workspace panel connected (the activity element calls this from its
   *  connect path). Marks the host connected and kicks the first parse;
   *  later parses reuse the in-flight job through the parseRequest guard, so
   *  overlapping jobs never run. A re-connect also resumes a parse that was
   *  aborted/stale while disconnected: an aborted run's `finally` only
   *  restarts when `isConnected` was already true, so with a pre-existing
   *  result the panel would otherwise stay outdated. */
  hostConnected(): void {
    this.host.isConnected = true;
    if (this.parseRequest === undefined && (this.result === undefined || this.stale)) void this.parse();
  }

  /** The workspace panel disconnected: `isConnected` drops late async writes
   *  until the workspace reconnects (§3.2), the in-flight parse run is aborted
   *  (W3), and any pending debounced invalidation is dropped so its timer
   *  cannot fire a parse into the disconnected panel. `stale` survives, so
   *  `hostConnected()` restarts the parse on reconnect. */
  hostDisconnected(): void {
    this.host.isConnected = false;
    this.abortController?.abort();
    this.cancelDebouncedInvalidation();
  }

  /** LRU eviction release (§3.2): the workspace left the registry, so late
   *  async writes drop even if the element stayed connected. Aborts the
   *  in-flight parse and cancels any debounced invalidation; terminal —
   *  re-rendering the workspace creates a fresh controller. */
  release(): void {
    this.host.isConnected = false;
    this.abortController?.abort();
    this.cancelDebouncedInvalidation();
  }

  /** Panel invalidation (W1): a manual refresh parses immediately (the
   *  existing Refresh semantics); automatic mutation / agent-activity
   *  invalidations are trailing-edge debounced so a burst coalesces into one
   *  parse. A debounced invalidation's promise settles when that coalesced
   *  parse completes, or immediately when the pending debounce is cancelled
   *  (manual parse/release/disconnect). The in-flight `parseRequest` join is
   *  untouched.
   *
   *  `stale` is set synchronously for every reason — but only once a result
   *  exists: with nothing parsed yet there is no stale report to mark, and the
   *  `loading` state already communicates the pending first parse. */
  invalidate(invalidation?: WorkspaceInvalidation): Promise<void> {
    this.stale = this.result !== undefined;
    this.requestUpdate();
    if (invalidation === undefined || invalidation.reason === "manual") {
      this.cancelDebouncedInvalidation();
      return this.parse();
    }
    return this.scheduleInvalidation();
  }

  parse(): Promise<void> {
    // The infinite-retry guard: re-entrant parses (Parse button spam,
    // invalidate during a run, workspace switch-back) join the running job
    // instead of stacking new ones.
    if (this.parseRequest !== undefined) return this.parseRequest;
    this.loading = true;
    this.error = undefined;
    this.requestUpdate();

    // One AbortController per run (W3). Only capability-v1 hosts accept the
    // options argument; legacy files are called with the path alone.
    const abort = new AbortController();
    this.abortController = abort;
    const options = this.context.files.capabilityVersion === 1 ? { signal: abort.signal } : undefined;

    const request = this.parseJob(this.context.files, options)
      .then((result) => {
        // An aborted run must never install its (partial/empty) result; its
        // `finally` restarts a fresh run once the panel reconnects.
        if (abort.signal.aborted) return;
        if (!this.host.isConnected) return;
        // The outline renders named rows only, so the kind filter is built
        // from the named kinds (an all-unnamed kind could never match).
        const kinds = namedOutlineKinds(result.index);
        if (this.kindFilter !== undefined && !kinds.includes(this.kindFilter)) this.kindFilter = undefined;
        this.result = result;
        this.stale = false;
        this.error = undefined;
        // W4 deep link: a query element id wins over the previous selection —
        // restore it only if the fresh outline still has that id (fail-safe:
        // a stale URL selects nothing, never the wrong element). Without a
        // query id, keep the previous selection when it survives the re-parse.
        const requested = navigationElementId(this.context.navigation);
        this.selectedId = selectionIn(result.report.outline, this.kindFilter, requested ?? this.selectedId);
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        if (this.host.isConnected) this.error = formatUnknownError(error);
      })
      .finally(() => {
        if (this.parseRequest !== request) return;
        this.parseRequest = undefined;
        if (this.abortController === abort) this.abortController = undefined;
        this.loading = false;
        this.requestUpdate();
        // A disconnect/eviction aborted this run before its result landed:
        // restart it when the panel is still/again connected. A terminal
        // release left `isConnected` false, so evicted workspaces never
        // restart.
        if (abort.signal.aborted && this.host.isConnected) void this.parse();
      });
    this.parseRequest = request;
    return request;
  }

  /** Select an outline row for the element-detail pane and mirror it into the
   *  contribution-scoped navigation query (W4) so the URL round-trips. Returns
   *  false when the host rejected the write (stale route); the selection is
   *  still applied locally. */
  selectRow(rowId: string): boolean {
    this.selectedId = rowId;
    // W4: mirror the selection into the contribution-scoped query so the URL
    // round-trips. `set` is typed `void` but PI-WEB returns false when the
    // retained context is stale (mirror the host terminal runtime); checking
    // that runtime boolean keeps a rejected write local-only with the URL
    // untouched — nothing to roll back.
    const navigationResult: unknown = this.context.navigation?.set("element", rowId);
    this.requestUpdate();
    return navigationResult !== false;
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

  /** Debounce one automatic invalidation (W1): restart the trailing-edge
   *  timer and return a promise that settles after the coalesced parse. */
  private scheduleInvalidation(): Promise<void> {
    if (this.invalidationTimer !== undefined) clearTimeout(this.invalidationTimer);
    const pending = new Promise<void>((resolve) => { this.invalidationWaiters.push(resolve); });
    this.invalidationTimer = setTimeout(() => {
      this.invalidationTimer = undefined;
      const waiters = this.invalidationWaiters;
      this.invalidationWaiters = [];
      void this.parse().finally(() => { for (const resolve of waiters) resolve(); });
    }, INVALIDATION_DEBOUNCE_MS);
    return pending;
  }

  /** Drop a pending debounced invalidation (manual parse or release) and
   *  settle its waiters so awaiting callers never hang. */
  private cancelDebouncedInvalidation(): void {
    if (this.invalidationTimer !== undefined) {
      clearTimeout(this.invalidationTimer);
      this.invalidationTimer = undefined;
    }
    const waiters = this.invalidationWaiters;
    this.invalidationWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** The deep-linked element id (W4), or undefined when the host supplies no
 *  navigation / no `element` query key. A repeated key takes its first value. */
function navigationElementId(navigation: WorkspacePanelNavigationV1 | undefined): string | undefined {
  const value = navigation?.query["element"];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
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