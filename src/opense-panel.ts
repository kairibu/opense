// ---------------------------------------------------------------------------
// OpenSE workspace panel: contributions, the per-workspace controller
// registry (plan §6.1 — one `OpenseWorkspaceController` per workspace, handed
// to consumers via properties), the in-browser parse job, and the
// change-guarded activity element.
//
// Browser-only adaptation of the git panel's controller/activity idiom
// (pi-web-plugins/git/browser/git-panel.ts): what git does as a
// `context.backend` round-trip becomes one in-browser job here —
// discovery walk (opense-discovery) → bounded concurrent reads → a single
// `loadModel(files)` merge → `createModelIndex` → outline + report
// (opense-contract + opense-outline). `context.files` is the only boundary;
// there is no `context.backend` anywhere in this module (plan §3.4).
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
//  - `onInvalidate` re-runs discovery + parse unconditionally for the
//    connected workspace — there is no owned-workspace gate to check.
//  - This is an in-browser parse (SysIDE/Arcadia-style subset), NOT semantic
//    validation: copy says "parse", never "validate", and diagnostics render
//    as the parser's pre-formatted output (plan §4 + risk 3).
//  - Shortcuts mod+6 / mod+shift+m: the collision check results are
//    documented at createOpenseActions (plan risk 2).
// ---------------------------------------------------------------------------

import type {
  HtmlTemplateTag,
  PluginAction,
  PluginContributions,
  PluginRuntimeContext,
  SvgTemplateTag,
  WorkspacePanelContext,
  WorkspacePanelContribution,
} from "@jmfederico/pi-web/plugin-api";
import type { Member, ModelIndex, Workspace as ParserWorkspace } from "./vendor/sysml-parser.bundle.js";
import { createModelIndex, loadModel } from "./vendor/sysml-parser.bundle.js";
import type { OpenseWorkspaceReport, OutlineRow, WorkspaceDiagnostic } from "./opense-contract.js";
import { openseReportFromWorkspace } from "./opense-contract.js";
import type { OpenseDiscoveryFiles } from "./opense-discovery.js";
import { discoverOpenseFiles } from "./opense-discovery.js";
import { elementDetails, namedOutlineKinds, namedOutlineRows, outlineRows, type OpenseElementDetails, type OpenseOwnedElement } from "./opense-outline.js";
import { defineCustomElementOnce } from "./opense-shared.js";
import { defineOpenseActionPaletteElement } from "./opense-panel-palette.js";
import { OpenseWorkspaceController, type OpenseWorkspaceHost } from "./opense-panel-controller.js";

const OPENSE_PANEL_LOCAL_ID = "workspace.opense";
// Keep parse state for a few recent workspaces so reports survive panel
// switches; evicted workspaces release their model index (heaviest field).
const OPENSE_WORKSPACE_STATE_LIMIT = 8;
const activityElementTag = "pi-web-opense-panel-activity";

/** Empty-state copy when the parse job produced no model: no `.sysml`
 *  files in the workspace, or every discovered file was binary/truncated/
 *  inaccessible (the discovery diagnostics above narrate which). */
const EMPTY_WORKSPACE_MESSAGE = "no parseable `.sysml` files found in this workspace";

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
 * touches `context.backend`.
 */
export async function parseOpenseWorkspace(files: OpenseDiscoveryFiles): Promise<OpenseParseResult> {
  const discovery = await discoverOpenseFiles(files);
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

/**
 * Browser contribution factory (mirrors the git browser entry shape minus the
 * source-plugin-id ownership parameter, which opense never uses): actions +
 * the always-visible workspace panel. `runtimePluginId` prefixes the panel
 * and action targets so qualified contribution references stay host-unique on
 * federated machines.
 */
export function createOpenseBrowserContributions(
  runtimePluginId: string,
  html: HtmlTemplateTag,
  svg: SvgTemplateTag,
): PluginContributions {
  const panelId = `${runtimePluginId}:${OPENSE_PANEL_LOCAL_ID}`;
  const registry = new OpenseWorkspaceRegistry();
  defineOpensePanelActivityElement();
  defineOpenseActionPaletteElement();
  return {
    actions: createOpenseActions(panelId),
    workspacePanels: [createOpensePanel(html, svg, registry)],
  };
}

/**
 * Per-workspace controller registry (plan §6.1 default: the panel module
 * keeps the per-workspace controller map and hands instances to consumers —
 * the activity element, the render functions — via properties; no Context
 * provider). Rendering a workspace refreshes its controller's context/files
 * handle and moves it to the LRU tail; past `OPENSE_WORKSPACE_STATE_LIMIT`
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

  /** Panel invalidation: re-run discovery + parse unconditionally for the
   *  connected workspace (browser-only plugin — no owned-workspace gate). */
  invalidate(context: WorkspacePanelContext): Promise<void> {
    return this.for(context).invalidate();
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

function createOpenseActions(panelId: string): PluginAction[] {
  return [
    {
      id: "view.opense",
      title: "Go to OpenSE",
      // Shortcut-collision check (plan risk 2): mod+6 is free in the current
      // keybinding map. Claimed today: core mod+1/2/4 (view.chat/files/
      // terminal, src/client/src/plugins/core/actions.ts), git mod+3
      // (view.git), plus mod+k, mod+,, mod+enter, mod+., and the mod+g * /
      // mod+shift+f / mod+shift+r sequences in PiWebApp.ts. syside's
      // mod+5 / mod+shift+y are NOT in this tree — and mod+6 avoids them and
      // every core/git combo above either way.
      shortcut: "mod+6",
      group: "Navigation",
      // Enabled unconditionally: no provider ownership to gate on.
      run: (context: PluginRuntimeContext) => { context.selectMainView(panelId); },
    },
    {
      id: "workspace.refresh-opense",
      title: "Refresh OpenSE",
      // Same collision-check result as above: mod+shift+m is unclaimed (the
      // repo's other mod+shift combos are f/g/r only).
      shortcut: "mod+shift+m",
      group: "Workspace",
      run: (context: PluginRuntimeContext) => context.refreshWorkspacePanels(panelId),
    },
  ];
}

function createOpensePanel(
  html: HtmlTemplateTag,
  svg: SvgTemplateTag,
  registry: OpenseWorkspaceRegistry,
): WorkspacePanelContribution {
  return {
    id: OPENSE_PANEL_LOCAL_ID,
    title: "OpenSE",
    icon: svg`
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"></path>
        <path d="M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"></path>
      </svg>
    `,
    order: 60,
    // Browser-only plugins own no workspace provider, so the panel is always
    // visible; the discovery-based empty state carries the "no files" story.
    visible: () => true,
    onInvalidate: (context) => registry.invalidate(context),
    render: (context) => renderOpensePanel(html, registry, context),
  };
}

function renderOpensePanel(html: HtmlTemplateTag, registry: OpenseWorkspaceRegistry, context: WorkspacePanelContext) {
  const controller = registry.for(context);
  return html`
    <section class="opense-panel">
      <style .textContent=${opensePanelStyles}></style>
      <pi-web-opense-panel-activity .controller=${controller} .context=${context}></pi-web-opense-panel-activity>
      <section class="opense-toolbar">
        <strong>OpenSE</strong>
        ${controller.stale ? html`<span class="opense-stale">stale</span>` : null}
        <div class="opense-toolbar-actions">
          ${controller.result === undefined ? null : html`<span class=${controller.result.report.ok ? "opense-status ok" : "opense-status issues"}>${controller.result.report.ok ? "ok" : "issues"}</span>`}
          <button type="button" ?disabled=${controller.loading} @click=${() => { void controller.parse(); }}>Parse</button>
        </div>
      </section>
      ${controller.error === undefined ? null : html`<div class="opense-error" role="alert">${controller.error}</div>`}
      <section class="opense-body">
        ${renderOpenseBody(html, controller, context)}
      </section>
    </section>
  `;
}

function renderOpenseBody(html: HtmlTemplateTag, controller: OpenseWorkspaceController, context: WorkspacePanelContext) {
  const report = controller.result?.report;
  if (report === undefined) {
    return html`<p class="opense-muted opense-standalone">${controller.loading ? "Parsing workspace…" : "Run Parse to build the model outline."}</p>`;
  }
  return html`
    <section class="opense-split">
      <section class="opense-left">
        ${renderDiagnostics(html, controller)}
        ${renderKindFilter(html, controller)}
        ${renderOutline(html, controller)}
      </section>
      <section class="opense-right">
        ${renderDetail(html, controller, context)}
      </section>
    </section>
  `;
}

function renderDiagnostics(html: HtmlTemplateTag, controller: OpenseWorkspaceController) {
  const diagnostics = controller.result?.report.diagnostics;
  if (diagnostics === undefined || diagnostics.length === 0) return null;
  return html`
    <section class="opense-diagnostics" aria-label="Diagnostics">
      ${diagnostics.map((diagnostic) => renderDiagnostic(html, diagnostic))}
    </section>
  `;
}

function renderDiagnostic(html: HtmlTemplateTag, diagnostic: WorkspaceDiagnostic) {
  return html`
    <div class=${`opense-diagnostic opense-${diagnostic.severity}`}>
      <span class="opense-severity">${diagnostic.severity}</span>
      <span class="opense-diagnostic-copy">
        ${diagnostic.path === undefined ? null : html`<code>${diagnostic.path}</code>`}
        ${diagnostic.message}
      </span>
    </div>
  `;
}

function renderKindFilter(html: HtmlTemplateTag, controller: OpenseWorkspaceController) {
  const index = controller.result?.index;
  if (index === undefined) return null;
  const kinds = namedOutlineKinds(index);
  if (kinds.length === 0) return null;
  return html`
    <div class="opense-kinds" role="group" aria-label="Element kinds">
      ${renderKindButton(html, controller, undefined, `All (${String(kinds.length)})`)}
      ${kinds.map((kind) => renderKindButton(html, controller, kind, kind))}
    </div>
  `;
}

function renderKindButton(
  html: HtmlTemplateTag,
  controller: OpenseWorkspaceController,
  kind: Member["kind"] | undefined,
  label: string,
) {
  const selected = controller.kindFilter === kind;
  return html`
    <button type="button" class=${selected ? "opense-kind-button is-selected" : "opense-kind-button"} aria-pressed=${String(selected)} @click=${() => { controller.setKindFilter(kind); }}>${label}</button>
  `;
}

function renderOutline(html: HtmlTemplateTag, controller: OpenseWorkspaceController) {
  const result = controller.result;
  if (result === undefined) return null;
  if (result.report.parsedFileCount === 0) {
    return html`<section class="opense-empty"><p>${EMPTY_WORKSPACE_MESSAGE}</p></section>`;
  }
  const filter = controller.kindFilter === undefined ? undefined : { kind: controller.kindFilter };
  const rows = namedOutlineRows(result.index, filter);
  if (rows.length === 0) {
    return html`<p class="opense-muted">No ${controller.kindFilter ?? "elements"} in the parsed model.</p>`;
  }
  return html`
    <div class="opense-outline" role="list" aria-label="Model outline">
      ${rows.map(({ row, depth }) => renderOutlineRow(html, controller, row, depth))}
    </div>
  `;
}

function renderOutlineRow(
  html: HtmlTemplateTag,
  controller: OpenseWorkspaceController,
  row: OutlineRow,
  depth: number,
) {
  const selected = controller.selectedId === row.id;
  return html`
    <button type="button" class=${selected ? "opense-row is-selected" : "opense-row"} style=${`--depth:${String(depth)}`} data-id=${row.id} @click=${() => { controller.selectRow(row.id); }}>
      ${row.name === undefined
        ? html`<span class="opense-row-name opense-unnamed">${row.kind}</span>`
        : html`<span class="opense-kind">${row.kind}</span><span class="opense-row-name">${row.name}</span>`}
    </button>
  `;
}

function renderDetail(html: HtmlTemplateTag, controller: OpenseWorkspaceController, context: WorkspacePanelContext) {
  const selectedId = controller.selectedId;
  if (selectedId === undefined) {
    return html`<p class="opense-muted">Select an element in the outline to inspect its details.</p>`;
  }
  const result = controller.result;
  const row = result?.report.outline.find((candidate) => candidate.id === selectedId);
  // result is always assigned at the end of a parse, and selectionIn clears
  // dangling selections after every re-parse, so a missing row or result only
  // fires for a selection that no longer exists in the current report —
  // "no longer available", never a loading state that cannot render.
  if (result === undefined || row === undefined) {
    return html`<p class="opense-muted">This element is no longer available. Run Parse again.</p>`;
  }
  // Resolved by exact id, so unnamed elements (synthetic <kind> ids) are
  // addressable here too — they are reached by clicking an owned row below.
  const details = elementDetails(result.index, result.workspace, row.id);
  if (details === undefined) {
    return html`<p class="opense-muted">This element is no longer available. Run Parse again.</p>`;
  }
  return html`
    ${renderElementDetails(html, controller, context, details)}
    <!-- Action palette pinned to the bottom of the details pane (syside
         prior art): Copy name / Investigate / Task for this element. The
         subject is the qualified name when present, falling back to the name
         and finally the index id — always something the prompt can address. -->
    <pi-web-opense-action-palette
      .subject=${details.qualifiedName ?? details.name ?? details.id}
      .filepath=${details.declaringFile}
      .context=${context}
    ></pi-web-opense-action-palette>
  `;
}

function renderElementDetails(
  html: HtmlTemplateTag,
  controller: OpenseWorkspaceController,
  context: WorkspacePanelContext,
  details: OpenseElementDetails,
) {
  return html`
    <section class="opense-detail" aria-label="Element details">
      <div class="opense-detail-head">
        <span class="opense-kind-badge">${details.kind}</span>
        <h3>${details.name ?? details.id}</h3>
      </div>
      ${details.qualifiedName === undefined ? null : html`<p class="opense-qualified">${details.qualifiedName}</p>`}
      ${details.parentChain.length === 0 ? null : html`<p class="opense-chain">${details.parentChain.join(" / ")}</p>`}
      ${details.declaringFile === undefined ? null : html`<p class="opense-declaring">declared in <code>${details.declaringFile}</code></p>`}
      ${details.fields.length === 0 ? null : html`
        <dl class="opense-fields">
          ${details.fields.map((field) => html`<div class="opense-field"><dt>${field.label}</dt><dd><code>${field.value}</code></dd></div>`)}
        </dl>
      `}
      ${details.owned.length === 0 ? null : html`
        <section class="opense-owned" aria-label="Owned elements">
          <h4>Owned elements</h4>
          ${details.owned.map((owned) => renderOwnedRow(html, controller, owned))}
        </section>
      `}
    </section>
  `;
}

/** One owned (direct child) element; clicking navigates to its details. */
function renderOwnedRow(
  html: HtmlTemplateTag,
  controller: OpenseWorkspaceController,
  owned: OpenseOwnedElement,
) {
  return html`
    <button type="button" class="opense-owned-row" data-id=${owned.id}
      @click=${() => { controller.selectRow(owned.id); }}>
      <span class="opense-kind">${owned.kind}</span>
      <span class=${owned.name === undefined ? "opense-row-name opense-unnamed" : "opense-row-name"}>
        ${owned.name ?? owned.syntheticLabel}
      </span>
      ${owned.preview === undefined ? null : html`<span class="opense-owned-preview">${owned.preview}</span>`}
    </button>
  `;
}

function defineOpensePanelActivityElement(): void {
  defineCustomElementOnce(activityElementTag, () => {
    class OpensePanelActivityElement extends HTMLElement {
      private controllerValue: OpenseWorkspaceController | undefined;
      private contextValue: WorkspacePanelContext | undefined;

      set controller(value: OpenseWorkspaceController | undefined) {
        if (this.controllerValue === value) return;
        this.controllerValue = value;
        this.restart();
      }

      // Change-guard: re-renders for the same workspace (host.requestRender
      // loops, tab switches) must not re-kick discovery/parse — only the
      // workspace identity changes do. With per-workspace controllers the
      // `.controller` swap already restarts; the context key guard keeps the
      // element quiet when the host hands out a fresh context object for the
      // same workspace.
      set context(value: WorkspacePanelContext | undefined) {
        const previousKey = this.contextValue === undefined ? undefined : workspaceContextKey(this.contextValue);
        this.contextValue = value;
        if (previousKey !== (value === undefined ? undefined : workspaceContextKey(value))) this.restart();
      }

      connectedCallback(): void {
        this.restart();
      }

      disconnectedCallback(): void {
        this.controllerValue?.hostDisconnected();
      }

      private restart(): void {
        if (!this.isConnected || this.controllerValue === undefined || this.contextValue === undefined) return;
        this.controllerValue.hostConnected();
      }
    }
    customElements.define(activityElementTag, OpensePanelActivityElement);
  });
}

function workspaceContextKey(context: WorkspacePanelContext): string {
  return JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id]);
}

const opensePanelStyles = `
  .opense-panel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--pi-text); background: var(--pi-bg); font: 13px system-ui, sans-serif; }
  .opense-panel ${activityElementTag} { display: none; }
  .opense-panel button { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-surface); color: var(--pi-text); padding: 5px 7px; cursor: pointer; }
  .opense-panel button:disabled { cursor: wait; opacity: .65; }
  .opense-panel code { border: 1px solid var(--pi-border-muted); border-radius: 5px; background: var(--pi-bg); padding: 1px 4px; font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .opense-panel small, .opense-panel .opense-muted { color: var(--pi-muted); }
  .opense-panel p { margin: 10px; }
  .opense-panel .opense-standalone { margin: 14px; }
  .opense-panel .opense-toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); }
  .opense-panel .opense-toolbar-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
  .opense-panel .opense-stale { border: 1px solid var(--pi-warning-border); border-radius: 999px; color: var(--pi-warning); padding: 1px 6px; font-size: 12px; }
  .opense-panel .opense-status { border: 1px solid var(--pi-border); border-radius: 999px; padding: 1px 6px; font-size: 12px; }
  .opense-panel .opense-status.ok { border-color: var(--pi-success-border); color: var(--pi-success); }
  .opense-panel .opense-status.issues { border-color: var(--pi-danger); color: var(--pi-danger); }
  .opense-panel .opense-error { flex: 0 0 auto; margin: 8px; border: 1px solid var(--pi-danger); border-radius: 7px; color: var(--pi-danger); padding: 8px; }
  .opense-panel .opense-body { flex: 1 1 auto; min-height: 0; overflow: auto; }
  .opense-panel .opense-split { height: 100%; display: grid; grid-template-rows: minmax(140px, 40%) minmax(0, 1fr); }
  .opense-panel .opense-left, .opense-panel .opense-right { min-height: 0; }
  .opense-panel .opense-left { border-bottom: 1px solid var(--pi-border-muted); overflow: auto; }
  /* Details pane: the detail content scrolls while the action palette stays
     pinned to the bottom edge at its natural (button-row) height. */
  .opense-panel .opense-right { display: flex; flex-direction: column; overflow: hidden; }
  .opense-panel .opense-right .opense-detail { flex: 1 1 auto; min-height: 0; overflow: auto; }
  .opense-panel .opense-right pi-web-opense-action-palette { flex: 0 0 auto; }
  .opense-panel .opense-diagnostics { border-bottom: 1px solid var(--pi-border); padding: 6px; display: grid; gap: 5px; }
  .opense-panel .opense-diagnostic { display: flex; align-items: baseline; gap: 6px; border-radius: 6px; padding: 5px 7px; }
  .opense-panel .opense-diagnostic.opense-error { border: 1px solid var(--pi-danger); background: color-mix(in srgb, var(--pi-danger) 9%, transparent); }
  .opense-panel .opense-diagnostic.opense-warning { border: 1px solid var(--pi-warning-border); background: color-mix(in srgb, var(--pi-warning) 9%, transparent); }
  .opense-panel .opense-severity { flex: 0 0 auto; border-radius: 999px; padding: 0 6px; font-size: 11px; font-weight: 600; }
  .opense-panel .opense-diagnostic.opense-error .opense-severity { background: var(--pi-danger); color: var(--pi-bg); }
  .opense-panel .opense-diagnostic.opense-warning .opense-severity { background: var(--pi-warning); color: var(--pi-bg); }
  .opense-panel .opense-diagnostic-copy { min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 5px; }
  .opense-panel .opense-kinds { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; gap: 5px; padding: 8px; border-bottom: 1px solid var(--pi-border); background: var(--pi-bg); }
  .opense-panel .opense-kind-button { border-radius: 999px; padding: 2px 9px; font-size: 12px; }
  .opense-panel .opense-kind-button.is-selected { border-color: var(--pi-accent); background: var(--pi-selection-bg); color: var(--pi-accent); }
  .opense-panel .opense-outline { padding: 6px; display: grid; gap: 1px; }
  .opense-panel .opense-row { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 7px; width: 100%; border: 0; border-radius: 5px; background: transparent; text-align: left; padding: 4px 6px 4px calc(6px + var(--depth, 0) * 14px); }
  .opense-panel .opense-row:hover, .opense-panel .opense-row.is-selected { background: var(--pi-selection-bg); }
  .opense-panel .opense-row .opense-kind { color: var(--pi-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
  .opense-panel .opense-row .opense-row-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .opense-panel .opense-row .opense-row-name.opense-unnamed { color: var(--pi-muted); font-style: italic; }
  /* align-content: start — the detail grid grows with the pane (flex above),
     and without this its auto rows would stretch to fill it, spreading the
     content vertically instead of keeping fixed line spacing. */
  .opense-panel .opense-detail { padding: 12px; display: grid; gap: 8px; align-content: start; }
  .opense-panel .opense-detail-head { display: flex; align-items: center; gap: 8px; }
  .opense-panel .opense-detail-head h3 { margin: 0; font-size: 15px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .opense-panel .opense-kind-badge { border: 1px solid var(--pi-accent-border); border-radius: 999px; color: var(--pi-accent); padding: 1px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
  .opense-panel .opense-qualified, .opense-panel .opense-chain, .opense-panel .opense-declaring { margin: 0; color: var(--pi-text-secondary); }
  .opense-panel .opense-fields { margin: 0; display: grid; gap: 5px; border-top: 1px solid var(--pi-border-muted); padding-top: 8px; }
  .opense-panel .opense-field { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px; align-items: baseline; }
  .opense-panel .opense-field dt { color: var(--pi-muted); font-size: 12px; }
  .opense-panel .opense-field dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .opense-panel .opense-owned { border-top: 1px solid var(--pi-border-muted); padding-top: 8px; display: grid; gap: 2px; }
  .opense-panel .opense-owned h4 { margin: 0 0 4px; color: var(--pi-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
  .opense-panel .opense-owned-row { display: grid; grid-template-columns: max-content minmax(0, 1fr) minmax(0, 1.2fr); gap: 7px; align-items: baseline; border: 0; border-radius: 5px; background: transparent; text-align: left; padding: 4px 6px; width: 100%; }
  .opense-panel .opense-owned-row:hover { background: var(--pi-selection-bg); }
  .opense-panel .opense-owned-row .opense-kind { color: var(--pi-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
  .opense-panel .opense-owned-row .opense-row-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .opense-panel .opense-owned-row .opense-row-name.opense-unnamed { color: var(--pi-muted); font-style: italic; }
  .opense-panel .opense-owned-preview { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pi-muted); font-size: 12px; }
  .opense-panel pi-web-opense-action-palette { border-top: 1px solid var(--pi-border-muted); padding: 8px 12px; background: var(--pi-bg); }
  .opense-panel .opense-empty { margin: 10px 12px; border: 1px dashed var(--pi-border-muted); border-radius: 8px; color: var(--pi-muted); padding: 12px; }
  .opense-panel .opense-empty p { margin: 0; }
`;