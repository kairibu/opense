// ---------------------------------------------------------------------------
// OpenSE workspace panel: contributions, the per-workspace controller
// registry (plan §6.1 — one `OpenseWorkspaceController` per workspace, handed
// to consumers via properties), the in-browser parse job, and the panel
// render wiring. The panel UI itself lives in the Lit elements of
// opense-panel-elements.ts (plan Phase 3): the host template only drives a
// single <pi-web-opense-panel-body> element, mirroring the workspace
// controller's render inputs into its reactive properties (the controller
// object is passed for actions and the activity lifecycle).
//
// Browser-only adaptation of the git panel's controller/activity idiom
// (pi-web-plugins/git/browser/git-panel.ts): what git does as a
// `context.backend` round-trip becomes one in-browser job here —
// discovery walk (opense-discovery) → bounded concurrent reads → a single
// `loadModel(files)` merge → `createModelIndex` → outline + report
// (opense-contract + opense-outline). `context.files` is the only boundary;
// there is no `context.backend` anywhere in this module (plan §3.4).
//
// Contribution shapes use the v5 plugin API (plan-v5 §2.A): Omit-based
// supersets of their v4 counterparts with discovery-augmented callback
// inputs, which the callbacks below ignore (type-level migration only).
//
// Plan note: plan-opense-plugin.md's "syside" references (its syside-panel /
// syside-contract template and actions) have no counterpart in this
// repository — the plan's syside idioms map onto the in-tree git-panel
// adaptation here, which is the template this module actually follows.
//
// Deliberate deviations from the git template (plan §3.4/§4):
//  - `visible: () => true`: a browser-only plugin never owns a workspace
//    provider, so ownership-gated visibility is impossible. After discovery
//    the panel itself communicates the empty state ("no parseable `.sysml`
//    files found in this workspace"); asynchronous detection cannot drive the sync
//    `visible` callback, so hiding is not attempted in v1.
//  - `onInvalidate` (W1) re-runs discovery + parse for the connected workspace
//    — there is no owned-workspace gate to check. Manual invalidations parse
//    immediately; automatic `workspace.files` invalidations (mutation /
//    agent-activity) are trailing-edge debounced in the controller so a burst
//    coalesces into one parse.
//  - This is an in-browser parse (SysIDE/Arcadia-style subset), NOT semantic
//    validation: copy says "parse", never "validate", and diagnostics render
//    as the parser's pre-formatted output (plan §4 + risk 3).
//  - Shortcuts mod+6 / mod+shift+m: the collision check results are
//    documented at createOpenseActions (plan risk 2).
// ---------------------------------------------------------------------------

import type {
  HtmlTemplateTag,
  MessageActionAvailabilityContextV5,
  MessageActionContributionV5,
  MessageActionContextV5,
  MessageActionFeedback,
  PluginActionV5,
  PluginContributionsV5,
  PluginRuntimeContext,
  SvgTemplateTag,
  WorkspaceInvalidation,
  WorkspacePanelContext,
  WorkspacePanelContributionV5,
} from "@jmfederico/pi-web/plugin-api";
import { html, svg } from "lit";
import type { ModelIndex, Workspace as ParserWorkspace } from "./vendor/sysml-parser.bundle.js";
import { createModelIndex, loadModel } from "./vendor/sysml-parser.bundle.js";
import type { OpenseWorkspaceReport } from "./opense-contract.js";
import { openseReportFromWorkspace } from "./opense-contract.js";
import type { OpenseDiscoveryFiles, OpenseDiscoveryRequestOptions } from "./opense-discovery.js";
import { discoverOpenseFiles } from "./opense-discovery.js";
import { outlineRows } from "./opense-outline.js";
import { openseReferenceChipExtension } from "./opense-panel-chips.js";
import {
  closeOpenseReferenceChooser,
  defineOpenseReferenceChooserElement,
  openOpenseReferenceChooser,
} from "./opense-panel-chooser.js";
import { defineOpenseActionPaletteElement } from "./opense-panel-palette.js";
import { openseReferenceCandidates } from "./opense-references.js";
import { defineOpensePanelElements } from "./opense-panel-elements.js";
import { createOpenseSessionLabel } from "./opense-session-labels.js";
import { openseClaimsSysmlLinks, setOpenseClaimsSysmlLinks } from "./opense-preferences.js";
import { OpenseWorkspaceController, type OpenseWorkspaceHost } from "./opense-panel-controller.js";

const OPENSE_PANEL_LOCAL_ID = "workspace.opense";
// Keep parse state for a few recent workspaces so reports survive panel
// switches; evicted workspaces release their model index (heaviest field).
const OPENSE_WORKSPACE_STATE_LIMIT = 8;

/** One parse job's full result: the report plus the objects detail views need.
 *  The controller (opense-panel-controller.ts) consumes this type-only, so the
 *  parse job and its result stay in this module (§3.2: parse code untouched). */
export interface OpenseParseResult {
  report: OpenseWorkspaceReport;
  index: ModelIndex;
  workspace: ParserWorkspace;
}

/**
 * One in-browser parse job: discovery walk → (concurrent reads are already
 * bounded inside discovery) → a single `loadModel(files)` call over every
 * discovered source → `createModelIndex` → outline + report. The injected
 * `files` adapter (structurally satisfied by `context.files`) is the only
 * boundary, so tests drive the whole job through a fake and the panel never
 * touches `context.backend`. `options` (W3) forwards the run's AbortSignal to
 * capability-v1 file adapters; legacy adapters are called without it.
 */
export async function parseOpenseWorkspace(
  files: OpenseDiscoveryFiles,
  options?: OpenseDiscoveryRequestOptions,
): Promise<OpenseParseResult> {
  const discovery = await discoverOpenseFiles(files, options);
  const workspace = loadModel(discovery.files);
  const index = createModelIndex(workspace);
  const outline = outlineRows(index);
  // The contract adapter validates the vendored Workspace shape at runtime
  // (one loud drift point); discovery diagnostics are already plugin-local
  // and render above the parser's, narrating skipped/truncated/inaccessible
  // files before parser output.
  const base = openseReportFromWorkspace(workspace, outline);
  const report: OpenseWorkspaceReport = {
    ...base,
    diagnostics: [...discovery.diagnostics, ...base.diagnostics],
    // Discovery errors (unreadable root/directories/files) fail the combined
    // result just like parser errors do.
    ok: base.ok && discovery.diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
  };
  return { report, index, workspace };
}

/** Browser contribution factory result (W2): the contributions plus the
 *  activation-result `dispose` that releases the per-workspace registry. */
export interface OpenseBrowserContributions {
  contributions: PluginContributionsV5;
  /** Release every cached per-workspace controller (host dispose/rollback). */
  dispose: () => void;
}

/**
 * Browser contribution factory (mirrors the git browser entry shape minus the
 * source-plugin-id ownership parameter, which opense never uses): actions +
 * the always-visible workspace panel. `runtimePluginId` prefixes the panel
 * and action targets so qualified contribution references stay host-unique on
 * federated machines.
 *
 * (W2) Also hands back the registry release as `dispose`, so the activation
 * result can free every cached model index on host shutdown instead of
 * relying on LRU eviction only.
 *
 * `html`/`svg` are accepted-but-ignored (plan §3.3): the elements render with
 * this module's own lit tags, but the parameter list is frozen so a single
 * revert restores the pre-refactor host-tag renderer.
 */
export function createOpenseBrowserContributions(
  runtimePluginId: string,
  html: HtmlTemplateTag,
  svg: SvgTemplateTag,
): OpenseBrowserContributions {
  const panelId = `${runtimePluginId}:${OPENSE_PANEL_LOCAL_ID}`;
  const registry = new OpenseWorkspaceRegistry();
  defineOpensePanelElements();
  defineOpenseActionPaletteElement();
  defineOpenseReferenceChooserElement();
  return {
    contributions: {
      actions: createOpenseActions(panelId),
      // C2: the chat message action resolving element references; C4: the
      // `[[Pkg::Wheel]]` markdown chip extension. Both share the extraction
      // grammar through opense-references.ts.
      messageActions: [createOpenseElementAction(panelId)],
      markdownExtensions: [openseReferenceChipExtension],
      // E4: the session-list row label for dispatched investigate/task
      // sessions (reopen deep link + pin/archive/restore lifecycle buttons),
      // built from the same runtimePluginId so the qualified panel tool id
      // matches the panel contribution above.
      sessionLabels: [createOpenseSessionLabel(runtimePluginId)],
      // C4/D3: the reference-chip stylesheet. The host sanitizer strips
      // inline styles from extension output, so the `.opense-ref` chip is
      // styled through a contributed CSS file (the host's documented
      // mechanism), reached with a module-relative URL that resolves in
      // both the src/ tree and the shipped dist/ layout (the build script
      // copies the file next to pi-web-plugin.js; esbuild never emits it —
      // the plugin-api import is types-only and no TS module imports CSS).
      stylesheets: [{
        id: "opense-chips",
        url: new URL("./opense-chips.css", import.meta.url).href,
      }],
      workspacePanels: [createOpensePanel(registry)],
    },
    dispose: () => {
      // C2 lifecycle: an open reference-chooser overlay (opened by the
      // message action) must not outlive the activation — close it BEFORE
      // the registry release frees the workspace controllers its picks
      // navigate through.
      closeOpenseReferenceChooser();
      registry.release();
    },
  };
}

/**
 * Per-workspace controller registry (plan §6.1 default: the panel module
 * keeps the per-workspace controller map and hands instances to consumers —
 * the body element — via properties; no Context provider). Rendering a
 * workspace refreshes its controller's context/files handle and moves it to
 * the LRU tail; past `OPENSE_WORKSPACE_STATE_LIMIT`
 * the oldest workspace is evicted (never the live panel — it is always the
 * tail) and its controller released, so late async writes are dropped (§3.2)
 * and its model index (heaviest field) is garbage-collected. Controllers keep
 * reports for a few recent workspaces so they survive panel switches without
 * re-parsing. */
class OpenseWorkspaceRegistry {
  private readonly workspaces = new Map<string, OpenseWorkspaceController>();

  /** Get-or-create the controller for a workspace (the render entry point). */
  for(context: WorkspacePanelContext): OpenseWorkspaceController {
    const key = workspaceContextKey(context);
    const existing = this.workspaces.get(key);
    if (existing !== undefined) {
      // Refresh the controller's CURRENT context handle and move to the LRU
      // tail (most recent) — mirrors the pre-refactor stateFor refresh. One
      // handle feeds both parse reads (`context.files`) and the render path
      // (`context.host.requestRender`), so the refreshed snapshot reaches
      // both.
      existing.context = context;
      this.workspaces.delete(key);
      this.workspaces.set(key, existing);
      return existing;
    }
    this.evictOldest();
    const controller = new OpenseWorkspaceController(new OpensePanelHost(), context, parseOpenseWorkspace);
    this.workspaces.set(key, controller);
    return controller;
  }

  /** Panel invalidation (W1): re-run discovery + parse for the connected
   *  workspace (browser-only plugin — no owned-workspace gate). The optional
   *  `invalidation` carries the reason, which gates debouncing. */
  invalidate(context: WorkspacePanelContext, invalidation?: WorkspaceInvalidation): Promise<void> {
    return this.for(context).invalidate(invalidation);
  }

  /** Release every cached workspace controller (W2 activation `dispose`):
   *  aborts in-flight parses, drops pending debounced invalidations, and
   *  clears the map so every model index is garbage-collected. */
  release(): void {
    for (const controller of this.workspaces.values()) controller.release();
    this.workspaces.clear();
  }

  private evictOldest(): void {
    if (this.workspaces.size < OPENSE_WORKSPACE_STATE_LIMIT) return;
    // Strictly oldest-first: the connected workspace is always the LRU tail —
    // every panel render of it calls for(), which bumps it — so the head is
    // never the live panel. The pre-refactor "skip the connected workspace"
    // preference had the same outcome (connect() also bumped it to the tail).
    const key = this.workspaces.keys().next().value;
    if (key === undefined) return;
    const controller = this.workspaces.get(key);
    if (controller !== undefined) controller.release();
    this.workspaces.delete(key);
  }
}

/** Host adapter for one workspace's controller: carries the connection flag
 *  the controller's late-async-write guards read (§3.2). The controller
 *  raises/lowers the flag from its own hostConnected/hostDisconnected/
 *  release lifecycle, so the adapter itself is a plain mutable state holder
 *  and holds no context — render routing goes through the controller's
 *  refreshed `context.host.requestRender()` instead. */
class OpensePanelHost implements OpenseWorkspaceHost {
  isConnected = false;
}

function createOpenseActions(panelId: string): PluginActionV5[] {
  return [
    {
      id: "view.opense",
      title: "Go to OpenSE",
      // Shortcut-collision check (plan §5, re-verified against the current
      // pi-web v1.202610.0 tree): mod+6 is free. Claimed today: core mod+1
      // (view.chat), mod+k, mod+,, mod+enter, mod+. and mod+g c
      // (src/client/src/plugins/core/actions.ts); bundled files mod+2 /
      // mod+shift+f, git mod+3 / mod+shift+g, terminal mod+4
      // (pi-web-plugins/*); and PiWebApp's mod+shift+r plus mod+g m/p/w/s
      // sequences. syside's mod+5 / mod+shift+y are NOT in this tree — and
      // mod+6 avoids them and every combo above either way.
      shortcut: "mod+6",
      group: "Navigation",
      // Enabled unconditionally: no provider ownership to gate on.
      run: (context: PluginRuntimeContext) => { context.selectWorkspaceTool(panelId); },
    },
    {
      id: "workspace.refresh-opense",
      title: "Refresh OpenSE",
      // Same collision-check result as above: mod+shift+m is unclaimed (the
      // only other mod+shift combos in the tree are mod+shift+f [files],
      // mod+shift+g [git], mod+shift+r [PiWebApp]).
      shortcut: "mod+shift+m",
      group: "Workspace",
      run: (context: PluginRuntimeContext) => context.refreshWorkspacePanels(panelId),
    },
    {
      // C1 (D1): per-browser toggle for the `.sysml` chat-link claim. No
      // shortcut — an occasional preference, not a frequent navigation
      // target. The title is a GETTER so each palette read reflects the
      // current preference: while claiming is ON the action offers to hand
      // the links back to Files, while OFF it offers to claim them for
      // OpenSE (clicking flips the state; `fileOpenQuery` reads it
      // synchronously per click, so no reload is needed).
      id: "opense.claim-sysml-links",
      group: "Workspace",
      get title() {
        return openseClaimsSysmlLinks() ? "Open .sysml links in Files" : "Open .sysml links in OpenSE";
      },
      run: () => { setOpenseClaimsSysmlLinks(!openseClaimsSysmlLinks()); },
    },
  ];
}

/**
 * C2 (plan-v5 §2.C): the "Open element in OpenSE" chat message action.
 * Detects qualified-name candidates in the message text (backticked spans
 * and `[[...]]` chips, via opense-references.ts), navigates the workspace
 * view to THIS panel with the picked candidate in the contribution-scoped
 * `element` query key, and lets the controller's deep-link restore step do
 * the resolving (exact row id → normalized qualified name → not-found
 * notice, opense-panel-controller.ts).
 *
 * Registry note (plan adaptation): the plan drafts the action closing over
 * the workspace registry, but `run` needs none of it — `context.navigate`
 * reaches the panel through the host, the panel parses on navigation, and
 * the registry instance is the same one the panel renders through. So the
 * action deliberately closes over the panel id only; there is no second
 * parse path.
 *
 * Enabled-context adaptation (verified against plugin-api.d.ts):
 * `MessageActionAvailabilityContextV5` carries machine/session/message but
 * NO `workspace` — the plan's `enabled({ workspace })` is not implementable
 * (workspace exists only on the run context). `enabled` therefore stays
 * trivial — an archived session cannot host the follow-up panel — and the
 * workspace check moved into `run`, which answers a missing workspace with
 * the ~1.2 s host toast "Open the element's workspace first" instead of
 * navigating.
 */
function createOpenseElementAction(panelId: string): MessageActionContributionV5 {
  return {
    id: "chat.open-opense-element",
    title: "Open element in OpenSE",
    // Pure sync, as the availability contract requires: extraction is
    // string scanning with a 50-candidate cap.
    visible: ({ message }: MessageActionAvailabilityContextV5) =>
      openseReferenceCandidates(message.text).length > 0,
    enabled: ({ session }: MessageActionAvailabilityContextV5) => !session.archived,
    run: async (context: MessageActionContextV5) => {
      const candidates = openseReferenceCandidates(context.message.text);
      // `visible` gates this path; the re-check is a defensive no-op.
      if (candidates.length === 0) return undefined;
      // Plan adaptation (see the function comment): the workspace lives only
      // on the run context, so its absence is answered here, not in `enabled`.
      if (context.workspace === undefined) {
        return { title: "Open the element's workspace first" } satisfies MessageActionFeedback;
      }
      if (candidates.length === 1) {
        return navigateToOpenseElement(context, panelId, candidates[0] ?? "");
      }
      // Several candidates: chooser overlay in the chat (a dedicated tiny
      // element, not the panel's action palette — see opense-panel-chooser.ts).
      // The pick navigates through this same captured context; the run itself
      // reports the chooser, since the pick's navigation cannot return
      // feedback through this promise.
      openOpenseReferenceChooser({
        candidates,
        onPick: (candidate: string) => {
          // The chooser is closed before this navigation settles, so no
          // overlay remains to surface a rejection on, and this plugin
          // keeps no runtime console surface (the host chat reports its
          // own navigation failures) — hence the deliberate silent catch
          // instead of an unhandled rejection.
          void navigateToOpenseElement(context, panelId, candidate)
            .catch(() => undefined);
        },
      });
      return { title: "Choose an element to open in OpenSE" } satisfies MessageActionFeedback;
    },
  };
}

/**
 * Navigate to the OpenSE panel with `candidate` in the `element` query key.
 * Patch mode keeps machine/project/workspace/session on the URL — the chat
 * stays where it is while the workspace view opens behind it — and the key
 * lands in the panel's contribution-query namespace, exactly where the
 * controller's restore step resolves it.
 */
async function navigateToOpenseElement(
  context: MessageActionContextV5,
  panelId: string,
  candidate: string,
): Promise<MessageActionFeedback> {
  await context.navigate(
    { view: "workspace", tool: panelId, query: { element: candidate } },
    { mode: "patch" },
  );
  return { title: `Opening ${candidate} in OpenSE`, ariaLabel: `Opening ${candidate} in the OpenSE panel` };
}

function createOpensePanel(registry: OpenseWorkspaceRegistry): WorkspacePanelContributionV5 {
  return {
    id: OPENSE_PANEL_LOCAL_ID,
    title: "OpenSE",
    // The panel icon is created with this module's own lit `svg` tag (plan
    // §3.3): the contributions factory accepts the host-injected html/svg
    // tags for the pre-refactor revert contract but nothing renders with
    // them anymore. A plugin-lit TemplateResult renders fine under the
    // host's lit-html — template results are structural objects, not tied to
    // a lit copy.
    icon: svg`
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"></path>
        <path d="M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"></path>
      </svg>
    `,
    // Below the Files panel (order 10) and OpenDoor (order 5): the host
    // resolves file-open / navigation arbitration by panel order, so OpenSE
    // must sort before Files to win deep links (W4a).
    order: 7,
    // Browser-only plugins own no workspace provider, so the panel is always
    // visible; the discovery-based empty state carries the "no files" story.
    visible: () => true,
    // W1: declare the fixed workspace resource whose automatic invalidations
    // (mutation, agent-activity) the host forwards here.
    invalidationResources: ["workspace.files"],
    onInvalidate: (context, invalidation) => registry.invalidate(context, invalidation),
    // C1 (D1): `.sysml` file links from the chat transcript open OpenSE at
    // file level. Claiming is preference-gated (default on) and
    // `.sysml`-only (case-insensitive); every other extension yields
    // `undefined` so the Files panel (order 10) answers as before. Read
    // synchronously per click, so the palette toggle takes effect without a
    // reload. The returned `{ file: path }` query drives the controller's
    // first-row-of-file restore (opense-panel-controller.ts).
    fileOpenQuery: (_context: WorkspacePanelContext, path: string) =>
      openseClaimsSysmlLinks() && path.toLowerCase().endsWith(".sysml") ? { file: path } : undefined,
    render: (context) => renderOpensePanel(registry, context),
  };
}

/**
 * Panel render wiring (plan Phase 3; state flow documented in
 * opense-panel-elements.ts): the host template drives the single body
 * element, mirroring the workspace controller's render inputs into its
 * reactive properties. The controller object itself is committed for
 * actions/lifecycle only — its identity never changes for a workspace, so
 * the *changed* mirrored values below are what re-render the shadow trees
 * (the controller pushes `requestRender` through its current context handle
 * on every state mutation, and the host re-invokes this function).
 */
function renderOpensePanel(registry: OpenseWorkspaceRegistry, context: WorkspacePanelContext) {
  const controller = registry.for(context);
  return html`
    <pi-web-opense-panel-body
      .controller=${controller}
      .context=${context}
      .result=${controller.result}
      .loading=${controller.loading}
      .stale=${controller.stale}
      .error=${controller.error}
      .selectedId=${controller.selectedId}
      .kindFilter=${controller.kindFilter}
      .selectionNotice=${controller.selectionNotice}
    ></pi-web-opense-panel-body>
  `;
}

function workspaceContextKey(context: WorkspacePanelContext): string {
  return JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id]);
}