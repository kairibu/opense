// ---------------------------------------------------------------------------
// OpenSE panel Lit elements (plan §3.1/§3.4, Phase 3): the workspace panel is
// now two LitElements instead of host-rendered template fragments with
// doc-wide `opense-*` CSS.
//
//   <pi-web-opense-panel-body>   — the panel root rendered by the host. Its
//     shadow root composes the toolbar (title + Parse trigger), the status
//     strip element, and the scrollable body region (diagnostics / kind
//     filter / outline / element-detail pane). All `opense-*` layout and
//     content rules live in its `static styles`; pi-web theming reaches it
//     only through the inherited `--pi-*` custom properties of the host
//     page (plan §3.4 — host chrome never reaches into the shadow root).
//   <pi-web-opense-panel-activity> — the status strip: stale badge, ok/issues
//     chip, and error alert (reactive props `loading`, `stale`, `error`,
//     `reportOk` per plan §3.1). It also drives the controller lifecycle:
//     the panel's manual ReactiveController wiring (plan §3.2, Phase 2
//     reviewer heads-up) has the activity element call `hostConnected()` /
//     `hostDisconnected()` from its connect path, so the parse job starts
//     when a workspace panel becomes visible and late async writes are
//     dropped while it is not.
//
// State flow (plan §6.1 default — registry hands controller instances to
// elements via properties, no Context provider): the host render function
// (opense-panel.ts) reads the workspace controller's fields at template
// construction and mirrors them into reactive properties on the body element
// (`.result .loading .stale .error .selectedId .kindFilter`). Every state
// mutation pushes `requestRender` through the controller's current context
// handle, the host re-renders, and the *changed* property values commit —
// that is what re-runs the elements' shadow templates. The controller object
// itself never changes identity for a given workspace, so nothing depends on
// same-object property commits (lit skips those); the controller is passed
// for *actions* (parse/selectRow/setKindFilter) and the activity lifecycle.
//
// The elements read `this.controller` only for action methods; everything
// rendered comes from the mirrored properties. `lit` is the element runtime;
// the vendor parser and the pure outline/contract modules are untouched.
// ---------------------------------------------------------------------------

import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { guard } from "lit/directives/guard.js";
import { repeat } from "lit/directives/repeat.js";
import { when } from "lit/directives/when.js";
import { property } from "lit/decorators.js";
import { buttonBase, microLabel, pill, truncate } from "./opense-styles.js";
import type { Member } from "./vendor/sysml-parser.bundle.js";
import type { OutlineRow, WorkspaceDiagnostic } from "./opense-contract.js";
import { elementDetails, namedOutlineKinds, namedOutlineRows, type OpenseElementDetails, type OpenseOwnedElement } from "./opense-outline.js";
import type { OpenseWorkspaceController } from "./opense-panel-controller.js";
import type { OpenseParseResult } from "./opense-panel.js";
import { defineCustomElementOnce } from "./opense-shared.js";

export const activityElementTag = "pi-web-opense-panel-activity";
export const bodyElementTag = "pi-web-opense-panel-body";

/** Empty-state copy when the parse job produced no model: no `.sysml`
 *  files in the workspace, or every discovered file was binary/truncated/
 *  inaccessible (the discovery diagnostics above narrate which). */
const EMPTY_WORKSPACE_MESSAGE = "no parseable `.sysml` files found in this workspace";

/**
 * Public property surface of the status-strip custom element (plan §3.1).
 * Host/tests use this type for property bindings and typed DOM lookups.
 * `reportOk` is undefined until a parse report exists (no status chip then);
 * `loading`'s only effect is `aria-busy` on the strip (the chip verdict is
 * pending while a parse runs) — the visible loading story stays on the Parse
 * button (`?disabled`) and the body's "Parsing workspace…" empty state, so
 * the chrome is behavior-identical to the pre-refactor panel.
 */
export interface OpensePanelActivityElement extends LitElement {
  controller: OpenseWorkspaceController | undefined;
  loading: boolean;
  stale: boolean;
  error: string | undefined;
  reportOk: boolean | undefined;
}

/**
 * Public property surface of the panel-root custom element. The host render
 * function mirrors the workspace controller's render inputs here (state flow
 * documented at the top of this module); `controller` provides the action
 * methods and `context` the palette's prompt editor.
 */
export interface OpensePanelBodyElement extends LitElement {
  controller: OpenseWorkspaceController | undefined;
  context: WorkspacePanelContext | undefined;
  result: OpenseParseResult | undefined;
  loading: boolean;
  stale: boolean;
  error: string | undefined;
  selectedId: string | undefined;
  kindFilter: Member["kind"] | undefined;
}

/** Register both panel elements; safe to call more than once (plugin modules
 *  can be evaluated across reloads — each call is guarded per tag). */
export function defineOpensePanelElements(): void {
  defineOpensePanelActivityElement();
  defineOpensePanelBodyElement();
}

function defineOpensePanelActivityElement(): void {
  defineCustomElementOnce(activityElementTag, () => {
    class OpensePanelActivityElement extends LitElement {
      /** The workspace controller this strip reports on and whose lifecycle
       *  it drives. Same-object re-commits are no-ops (lit skips them); a
       *  genuinely different controller (workspace switch) disconnects the
       *  old one and connects the new one in willUpdate. */
      @property({ attribute: false })
      controller: OpenseWorkspaceController | undefined;

      @property({ attribute: false })
      loading = false;

      @property({ attribute: false })
      stale = false;

      @property({ attribute: false })
      error: string | undefined;

      @property({ attribute: false })
      reportOk: boolean | undefined;

      static override styles = [
        pill,
        css`
        :host {
          display: block;
        }

        .opense-strip {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 6px;
          padding: 6px 8px 0;
        }

        /* pill fragment supplies radius/padding/font-size; only the color
           story differs per chip. */
        .opense-stale {
          border: 1px solid var(--pi-warning-border);
          color: var(--pi-warning);
        }

        .opense-status {
          border: 1px solid var(--pi-border);
        }

        .opense-status.ok {
          border-color: var(--pi-success-border);
          color: var(--pi-success);
        }

        .opense-status.issues {
          border-color: var(--pi-danger);
          color: var(--pi-danger);
        }

        .opense-error {
          margin: 8px;
          border: 1px solid var(--pi-danger);
          border-radius: 7px;
          color: var(--pi-danger);
          padding: 8px;
        }
      `,
      ];

      override connectedCallback(): void {
        super.connectedCallback();
        // The workspace panel became visible: raise the controller's
        // connection flag and kick the first parse (idempotent — a cached
        // report or an in-flight parseRequest is left alone, §3.2).
        this.controller?.hostConnected();
      }

      override disconnectedCallback(): void {
        super.disconnectedCallback();
        // The panel left the DOM: drop the connection flag so late async
        // writes (parse results landing afterwards) are discarded until the
        // workspace reconnects (plan §3.2 — the `retained` flag's
        // replacement).
        this.controller?.hostDisconnected();
      }

      protected override willUpdate(changedProperties: PropertyValues<this>): void {
        // Workspace switch while the element stays connected (the host
        // re-commits a DIFFERENT controller): end the old workspace's
        // connection, start the new one's — the same connect path the
        // pre-refactor element ran on its `.controller`/`.context` change
        // guards (the per-workspace controller identity now carries the
        // workspace identity, so the context-key guard is redundant).
        //
        // A `previous === undefined` commit is skipped: the initial mount's
        // connect already happened in connectedCallback, so re-running it
        // here would be a redundant second hostConnected on first render
        // (harmless only because parseRequest guards re-entry). The swap
        // itself is also gated on `this.isConnected` — a controller commit
        // landing while the element is detached (a pending update flushing
        // after unmount) must not raise a connection flag off-DOM: parity
        // with the pre-refactor restart()'s `!this.isConnected` early return
        // (plan §3.2 late-async-write-drop contract).
        if (this.isConnected && changedProperties.has("controller")) {
          const previous = changedProperties.get("controller") as OpenseWorkspaceController | undefined;
          if (previous !== undefined && previous !== this.controller) {
            previous?.hostDisconnected();
            this.controller?.hostConnected();
          }
        }
      }

      protected override render(): TemplateResult {
        const reportOk = this.reportOk;
        return html`
          ${this.stale || reportOk !== undefined
            ? html`<div class="opense-strip" aria-busy=${this.loading ? "true" : "false"}>
                ${this.stale ? html`<span class="opense-stale">stale</span>` : nothing}
                ${reportOk === undefined
                  ? nothing
                  : html`<span class=${reportOk ? "opense-status ok" : "opense-status issues"}>${reportOk ? "ok" : "issues"}</span>`}
              </div>`
            : nothing}
          ${this.error === undefined ? nothing : html`<div class="opense-error" role="alert">${this.error}</div>`}
        `;
      }
    }
    customElements.define(activityElementTag, OpensePanelActivityElement);
  });
}

function defineOpensePanelBodyElement(): void {
  defineCustomElementOnce(bodyElementTag, () => {
    class OpensePanelBodyElement extends LitElement {
      /** Action surface (parse/selectRow/setKindFilter) + activity lifecycle
       *  hand-off; all rendered inputs arrive via the mirrored properties
       *  below (module header documents the state flow). */
      @property({ attribute: false })
      controller: OpenseWorkspaceController | undefined;

      /** Workspace context for the action palette's prompt editor. */
      @property({ attribute: false })
      context: WorkspacePanelContext | undefined;

      /** Parse result (mirrored from the controller; new object per parse). */
      @property({ attribute: false })
      result: OpenseParseResult | undefined;

      @property({ attribute: false })
      loading = false;

      @property({ attribute: false })
      stale = false;

      @property({ attribute: false })
      error: string | undefined;

      @property({ attribute: false })
      selectedId: string | undefined;

      @property({ attribute: false })
      kindFilter: Member["kind"] | undefined;

      static override styles = [
        buttonBase,
        pill,
        microLabel,
        truncate,
        css`
        /* The body element IS the panel root the pi-web host sizes; :host
           takes the pre-refactor .opense-panel's flex-item role (the host
           chrome styles its flex children, and --pi-* custom properties
           inherit into the shadow root for theming — plan §3.4). */
        :host {
          flex: 1 1 auto;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          color: var(--pi-text);
          background: var(--pi-bg);
          font: 13px system-ui, sans-serif;
        }

        /* buttonBase supplies the shared core; these four are the body's
           deliberate variation (the palette picks different values). */
        button {
          border-radius: 7px;
          background: var(--pi-surface);
          color: var(--pi-text);
          padding: 5px 7px;
        }

        button:disabled {
          cursor: wait;
          opacity: 0.65;
        }

        code {
          border: 1px solid var(--pi-border-muted);
          border-radius: 5px;
          background: var(--pi-bg);
          padding: 1px 4px;
          font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }

        small,
        .opense-muted {
          color: var(--pi-muted);
        }

        p {
          margin: 10px;
        }

        .opense-standalone {
          margin: 14px;
        }

        .opense-toolbar {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px;
          border-bottom: 1px solid var(--pi-border-muted);
        }

        .opense-toolbar-actions {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-left: auto;
        }

        .opense-body {
          flex: 1 1 auto;
          min-height: 0;
          overflow: auto;
        }

        .opense-split {
          height: 100%;
          display: grid;
          grid-template-rows: minmax(140px, 40%) minmax(0, 1fr);
        }

        .opense-left,
        .opense-right {
          min-height: 0;
        }

        .opense-left {
          border-bottom: 1px solid var(--pi-border-muted);
          overflow: auto;
        }

        /* Details pane: the detail content scrolls while the action palette
           stays pinned to the bottom edge at its natural (button-row) height. */
        .opense-right {
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .opense-right .opense-detail {
          flex: 1 1 auto;
          min-height: 0;
          overflow: auto;
        }

        pi-web-opense-action-palette {
          flex: 0 0 auto;
          border-top: 1px solid var(--pi-border-muted);
          padding: 8px 12px;
          background: var(--pi-bg);
        }

        .opense-diagnostics {
          border-bottom: 1px solid var(--pi-border);
          padding: 6px;
          display: grid;
          gap: 5px;
        }

        .opense-diagnostic {
          display: flex;
          align-items: baseline;
          gap: 6px;
          border-radius: 6px;
          padding: 5px 7px;
        }

        .opense-diagnostic.opense-error {
          border: 1px solid var(--pi-danger);
          background: color-mix(in srgb, var(--pi-danger) 9%, transparent);
        }

        .opense-diagnostic.opense-warning {
          border: 1px solid var(--pi-warning-border);
          background: color-mix(in srgb, var(--pi-warning) 9%, transparent);
        }

        .opense-severity {
          flex: 0 0 auto;
          padding: 0 6px;
          font-size: 11px;
          font-weight: 600;
        }

        .opense-diagnostic.opense-error .opense-severity {
          background: var(--pi-danger);
          color: var(--pi-bg);
        }

        .opense-diagnostic.opense-warning .opense-severity {
          background: var(--pi-warning);
          color: var(--pi-bg);
        }

        .opense-diagnostic-copy {
          min-width: 0;
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 5px;
        }

        .opense-kinds {
          position: sticky;
          top: 0;
          z-index: 1;
          display: flex;
          flex-wrap: wrap;
          gap: 5px;
          padding: 8px;
          border-bottom: 1px solid var(--pi-border);
          background: var(--pi-bg);
        }

        .opense-kind-button {
          padding: 2px 9px;
        }

        .opense-kind-button.is-selected {
          border-color: var(--pi-accent);
          background: var(--pi-selection-bg);
          color: var(--pi-accent);
        }

        .opense-outline {
          padding: 6px;
          display: grid;
          gap: 1px;
        }

        /* One row base for outline rows AND owned-element rows (the owned
           variant adds a third column + baseline alignment via .owned);
           the --depth indent defaults to 0 for owned rows. */
        .opense-row {
          display: grid;
          grid-template-columns: max-content minmax(0, 1fr);
          gap: 7px;
          width: 100%;
          border: 0;
          border-radius: 5px;
          background: transparent;
          text-align: left;
          padding: 4px 6px 4px calc(6px + var(--depth, 0) * 14px);
        }

        .opense-row.owned {
          grid-template-columns: max-content minmax(0, 1fr) minmax(0, 1.2fr);
          align-items: baseline;
        }

        .opense-row:hover,
        .opense-row.is-selected {
          background: var(--pi-selection-bg);
        }

        .opense-row .opense-kind {
          ${microLabel}
        }

        .opense-row .opense-row-name {
          ${truncate}
        }

        .opense-row .opense-row-name.opense-unnamed {
          color: var(--pi-muted);
          font-style: italic;
        }

        /* align-content: start — the detail grid grows with the pane (flex
           above), and without this its auto rows would stretch to fill it,
           spreading the content vertically instead of keeping fixed line
           spacing. */
        .opense-detail {
          padding: 12px;
          display: grid;
          gap: 8px;
          align-content: start;
        }

        .opense-detail-head {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .opense-detail-head h3 {
          margin: 0;
          font-size: 15px;
          ${truncate}
        }

        .opense-kind-badge {
          border: 1px solid var(--pi-accent-border);
          color: var(--pi-accent);
          padding: 1px 8px;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }

        .opense-qualified,
        .opense-chain,
        .opense-declaring {
          margin: 0;
          color: var(--pi-text-secondary);
        }

        .opense-fields {
          margin: 0;
          display: grid;
          gap: 5px;
          border-top: 1px solid var(--pi-border-muted);
          padding-top: 8px;
        }

        .opense-field {
          display: grid;
          grid-template-columns: max-content minmax(0, 1fr);
          gap: 10px;
          align-items: baseline;
        }

        .opense-field dt {
          color: var(--pi-muted);
          font-size: 12px;
        }

        .opense-field dd {
          margin: 0;
          min-width: 0;
          overflow-wrap: anywhere;
        }

        .opense-owned {
          border-top: 1px solid var(--pi-border-muted);
          padding-top: 8px;
          display: grid;
          gap: 2px;
        }

        .opense-owned h4 {
          margin: 0 0 4px;
          ${microLabel}
        }

        .opense-owned-preview {
          ${truncate}
          color: var(--pi-muted);
          font-size: 12px;
        }

        .opense-empty {
          margin: 10px 12px;
          border: 1px dashed var(--pi-border-muted);
          border-radius: 8px;
          color: var(--pi-muted);
          padding: 12px;
        }

        .opense-empty p {
          margin: 0;
        }
      `,
      ];

      protected override render(): TemplateResult {
        return html`
          <section class="opense-toolbar">
            <strong>OpenSE</strong>
            <div class="opense-toolbar-actions">
              <button type="button" ?disabled=${this.loading} @click=${this.onParseClick}>Parse</button>
            </div>
          </section>
          <pi-web-opense-panel-activity
            .controller=${this.controller}
            .loading=${this.loading}
            .stale=${this.stale}
            .error=${this.error}
            .reportOk=${this.result?.report.ok}
          ></pi-web-opense-panel-activity>
          <section class="opense-body">
            ${this.renderBodyContent()}
          </section>
        `;
      }

      private onParseClick = (): void => {
        void this.controller?.parse();
      };

      private renderBodyContent(): TemplateResult {
        const result = this.result;
        if (result === undefined) {
          return html`<p class="opense-muted opense-standalone">${this.loading ? "Parsing workspace…" : "Run Parse to build the model outline."}</p>`;
        }
        return html`
          <section class="opense-split">
            <section class="opense-left">
              ${guard(
                // Diagnostics are a pure function of the parse result, so
                // guard keys them on it: selection/loading/stale/error
                // re-renders keep the committed subtree (plan §3.4). The
                // outline/detail dismiss a guard — their output also reads
                // the selection (and the detail the context), so their keys
                // would carry everything they read and skip nothing.
                [result],
                () => when(result.report.diagnostics.length > 0, () => this.renderDiagnostics(result)),
              )}
              ${this.renderKindFilter(result)}
              ${this.renderOutline(result)}
            </section>
            <section class="opense-right">
              ${this.renderDetail(result)}
            </section>
          </section>
        `;
      }

      private renderDiagnostics(result: OpenseParseResult): TemplateResult {
        return html`
          <section class="opense-diagnostics" aria-label="Diagnostics">
            ${result.report.diagnostics.map((diagnostic) => this.renderDiagnostic(diagnostic))}
          </section>
        `;
      }

      private renderDiagnostic(diagnostic: WorkspaceDiagnostic): TemplateResult {
        return html`
          <div class=${`opense-diagnostic opense-${diagnostic.severity}`}>
            <span class="opense-severity">${diagnostic.severity}</span>
            <span class="opense-diagnostic-copy">
              ${diagnostic.path === undefined ? nothing : html`<code>${diagnostic.path}</code>`}
              ${diagnostic.message}
            </span>
          </div>
        `;
      }

      private renderKindFilter(result: OpenseParseResult): TemplateResult | typeof nothing {
        const kinds = namedOutlineKinds(result.index);
        return when(
          kinds.length > 0,
          () => html`
            <div class="opense-kinds" role="group" aria-label="Element kinds">
              ${this.renderKindButton(undefined, `All (${String(kinds.length)})`)}
              ${kinds.map((kind) => this.renderKindButton(kind, kind))}
            </div>
          `,
          () => nothing,
        );
      }

      private renderKindButton(kind: Member["kind"] | undefined, label: string): TemplateResult {
        const selected = this.kindFilter === kind;
        return html`
          <button
            type="button"
            class=${classMap({ "opense-kind-button": true, "is-selected": selected })}
            aria-pressed=${String(selected)}
            @click=${() => { this.controller?.setKindFilter(kind); }}
          >${label}</button>
        `;
      }

      private renderOutline(result: OpenseParseResult): TemplateResult {
        if (result.report.parsedFileCount === 0) {
          return html`<section class="opense-empty"><p>${EMPTY_WORKSPACE_MESSAGE}</p></section>`;
        }
        const filter = this.kindFilter === undefined ? undefined : { kind: this.kindFilter };
        const rows = namedOutlineRows(result.index, filter);
        if (rows.length === 0) {
          return html`<p class="opense-muted">No ${this.kindFilter ?? "elements"} in the parsed model.</p>`;
        }
        return html`
          <div class="opense-outline" role="list" aria-label="Model outline">
            ${repeat(rows, ({ row }) => row.id, (entry) => this.renderOutlineRow(entry.row, entry.depth))}
          </div>
        `;
      }

      private renderOutlineRow(row: OutlineRow, depth: number): TemplateResult {
        const selected = this.selectedId === row.id;
        return html`
          <button
            type="button"
            class=${classMap({ "opense-row": true, "is-selected": selected })}
            style=${`--depth:${String(depth)}`}
            data-id=${row.id}
            @click=${() => { this.controller?.selectRow(row.id); }}
          >
            ${row.name === undefined
              ? html`<span class="opense-row-name opense-unnamed">${row.kind}</span>`
              : html`<span class="opense-kind">${row.kind}</span><span class="opense-row-name">${row.name}</span>`}
          </button>
        `;
      }

      private renderDetail(result: OpenseParseResult): TemplateResult {
        const selectedId = this.selectedId;
        if (selectedId === undefined) {
          return html`<p class="opense-muted">Select an element in the outline to inspect its details.</p>`;
        }
        const row = result.report.outline.find((candidate) => candidate.id === selectedId);
        // result is always assigned at the end of a parse, and selectionIn
        // clears dangling selections after every re-parse, so a missing row
        // only fires for a selection that no longer exists in the current
        // report — "no longer available", never a loading state that cannot
        // render.
        if (row === undefined) {
          return html`<p class="opense-muted">This element is no longer available. Run Parse again.</p>`;
        }
        // Resolved by exact id, so unnamed elements (synthetic <kind> ids)
        // are addressable here too — they are reached by clicking an owned
        // row below.
        const details = elementDetails(result.index, result.workspace, row.id);
        if (details === undefined) {
          return html`<p class="opense-muted">This element is no longer available. Run Parse again.</p>`;
        }
        return html`
          ${this.renderElementDetails(details)}
          <!-- Action palette pinned to the bottom of the details pane (syside
               prior art): Copy name / Investigate / Task for this element. The
               subject is the qualified name when present, falling back to the
               name and finally the index id — always something the prompt can
               address. -->
          <pi-web-opense-action-palette
            .subject=${details.qualifiedName ?? details.name ?? details.id}
            .filepath=${details.declaringFile}
            .context=${this.context}
          ></pi-web-opense-action-palette>
        `;
      }

      private renderElementDetails(details: OpenseElementDetails): TemplateResult {
        return html`
          <section class="opense-detail" aria-label="Element details">
            <div class="opense-detail-head">
              <span class="opense-kind-badge">${details.kind}</span>
              <h3>${details.name ?? details.id}</h3>
            </div>
            ${details.qualifiedName === undefined ? nothing : html`<p class="opense-qualified">${details.qualifiedName}</p>`}
            ${details.parentChain.length === 0 ? nothing : html`<p class="opense-chain">${details.parentChain.join(" / ")}</p>`}
            ${details.declaringFile === undefined ? nothing : html`<p class="opense-declaring">declared in <code>${details.declaringFile}</code></p>`}
            ${details.fields.length === 0
              ? nothing
              : html`
                  <dl class="opense-fields">
                    ${details.fields.map((field) => html`<div class="opense-field"><dt>${field.label}</dt><dd><code>${field.value}</code></dd></div>`)}
                  </dl>
                `}
            ${details.owned.length === 0
              ? nothing
              : html`
                  <section class="opense-owned" aria-label="Owned elements">
                    <h4>Owned elements</h4>
                    ${details.owned.map((owned) => this.renderOwnedRow(owned))}
                  </section>
                `}
          </section>
        `;
      }

      /** One owned (direct child) element; clicking navigates to its details. */
      private renderOwnedRow(owned: OpenseOwnedElement): TemplateResult {
        return html`
          <button
            type="button"
            class="opense-row owned"
            data-id=${owned.id}
            @click=${() => { this.controller?.selectRow(owned.id); }}
          >
            <span class="opense-kind">${owned.kind}</span>
            <span class=${owned.name === undefined ? "opense-row-name opense-unnamed" : "opense-row-name"}>
              ${owned.name ?? owned.syntheticLabel}
            </span>
            ${owned.preview === undefined ? nothing : html`<span class="opense-owned-preview">${owned.preview}</span>`}
          </button>
        `;
      }
    }
    customElements.define(bodyElementTag, OpensePanelBodyElement);
  });
}