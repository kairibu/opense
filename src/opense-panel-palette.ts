// ---------------------------------------------------------------------------
// OpenSE element action palette: a Lit element rendered below the
// element-detail pane offering Investigate (lightbulb), Task (pencil), and
// Copy name (copy) actions for the selected element. Direct adaptation of the
// syside palette (pi-web-plugins/syside/browser/syside-panel-palette.ts),
// simplified for opense's data model: the subject is one display string
// (qualified name, falling back to name/id) instead of a qualified-name
// segment array, and the optional location is the element's declaring file.
//
// Lit-based element (LitElement + reactive properties + declarative event
// bindings + scoped static styles): plugin modules no longer load without an
// import map — scripts/build-plugin.mjs esbuild-bundles the entry and its
// npm dependencies, so bare `lit` imports resolve at runtime.
// ---------------------------------------------------------------------------

import type { PluginPromptEditor, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { LitElement, css, html, svg, type PropertyValues, type TemplateResult } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { createRef, ref } from "lit/directives/ref.js";
import { property, state } from "lit/decorators.js";
import { contextPrompt, editPrompt } from "./opense-prompts.js";
import { buttonBase } from "./opense-styles.js";
import { defineCustomElementOnce } from "./opense-shared.js";

export const actionPaletteElementTag = "pi-web-opense-action-palette";

/**
 * Public property surface of the action palette custom element. Host code and
 * tests use this type for property bindings and typed DOM lookups.
 */
export interface OpenseActionPaletteElement extends LitElement {
  /** Display string addressing the element in prompts (never empty). */
  subject: string | undefined;
  filepath: string | undefined;
  context: WorkspacePanelContext | undefined;
}

/**
 * Toolbar icon for the fixed "Investigate" action (lightbulb). A lit `svg`
 * template (no `xmlns` needed — lit sets the SVG namespace itself) with
 * `aria-hidden` because each use is paired with a real `aria-label` button.
 */
export const investigateIconSvg = svg`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>`;

/**
 * Toolbar icon for the custom "Task" action (pencil with sparkles). Same
 * accessibility contract as `investigateIconSvg`.
 */
export const taskIconSvg = svg`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3H8"/><path d="m15.007 5.008 3.987 3.986"/><path d="M20 15v4"/><path d="M21.174 6.813a2.82 2.82 0 0 0-3.986-3.987L3.842 16.175a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="M22 17h-4"/><path d="M4 5v4"/><path d="M6 7H2"/><path d="M9 2v2"/></svg>`;

/**
 * Toolbar icon for the "Copy name" action (two overlapping rounded rects).
 * Same accessibility contract as the other icons.
 */
export const copyIconSvg = svg`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;

/**
 * Insert the fixed investigation prompt for an element into the given prompt
 * editor. `filepath` is optional (elements without provenance simply omit the
 * location clause of the prompt). A missing editor is a no-op.
 */
export function insertInvestigatePrompt(
  prompt: PluginPromptEditor | undefined,
  filepath: string | undefined,
  subject: string,
): void {
  prompt?.insertText(contextPrompt(filepath, subject));
}

/**
 * Insert a custom-task prompt for an element into the given prompt editor.
 * `task` is expected to be already trimmed and non-empty (the element gates
 * submission on that before calling).
 */
export function insertTaskPrompt(
  prompt: PluginPromptEditor | undefined,
  filepath: string | undefined,
  subject: string,
  task: string,
): void {
  prompt?.insertText(editPrompt(filepath, subject, task));
}

/**
 * Insert only the element's subject string (e.g. `Tracker::Parts::lens`) into
 * the given prompt editor — no location clause and no surrounding wording,
 * unlike the Investigate prompt. A missing editor is a no-op.
 */
export function insertCopyNamePrompt(
  prompt: PluginPromptEditor | undefined,
  subject: string,
): void {
  prompt?.insertText(subject);
}

/**
 * Lit element providing horizontal Copy name, Investigate, and Task controls
 * plus a conditional inline task input, for the selected element in the
 * OpenSE detail pane. The Investigate button inserts a fixed investigation
 * prompt; the Copy name button inserts the bare subject string; the Task
 * button opens an inline input whose submitted text is inserted as a custom
 * prompt.
 *
 * Interaction semantics mirror the syside palette: a trimmed non-empty Enter
 * submits, Escape or blur closes without inserting, and reselecting Task
 * while the input is open clears and refocuses it.
 *
 * Safe to call more than once on the same page: it re-registers only when the
 * custom element is not defined yet.
 */
export function defineOpenseActionPaletteElement(): void {
  defineCustomElementOnce(actionPaletteElementTag, () => {
    class OpenseActionPaletteElement extends LitElement {
      /** Reactive property bindings from the host (lit-html property parts
       *  re-commit every render, but Lit's default `hasChanged` compares with
       *  Object.is, so only genuinely different values schedule an update).
       *  Never reflected to attributes — the palette is driven entirely via
       *  `.subject`/`.filepath`/`.context` property bindings. */
      @property({ attribute: false })
      subject: string | undefined;

      @property({ attribute: false })
      filepath: string | undefined;

      @property({ attribute: false })
      context: WorkspacePanelContext | undefined;

      /** Whether the inline task input is open. Rendered as the input's
       *  `is-visible` class; true is the only value that makes the input
       *  focusable (its CSS is `display: none` otherwise). */
      @state()
      private editing = false;

      /** Reference to the always-rendered task input; its value stays
       *  uncontrolled (typed by the user, cleared by open/close). */
      private inputRef = createRef<HTMLInputElement>();

      static override styles = [
        buttonBase,
        css`
        :host {
          display: block;
        }

        .palette {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 6px;
        }

        /* buttonBase supplies the shared core; these four are the palette's
           deliberate variation (the body's buttons pick different values). */
        .palette button {
          border-radius: 6px;
          background: var(--pi-surface-hover);
          color: var(--pi-text-secondary);
          padding: 4px 8px;
        }

        .palette button:hover {
          background: var(--pi-selection-bg);
        }

        .palette-input {
          background: var(--pi-surface);
          border: 1px solid var(--pi-border);
          border-radius: 4px;
          color: var(--pi-text);
          font-size: 12px;
          padding: 4px 6px;
          min-width: 200px;
          outline: 2px solid var(--pi-accent-border);
          display: none;
        }

        .palette-input.is-visible {
          display: block;
        }

        .palette-input::placeholder {
          color: var(--pi-dim);
        }
      `,
      ];

      protected override willUpdate(changedProperties: PropertyValues<this>): void {
        // The host reuses the same palette DOM node across element
        // selections, so a genuinely changed element identity must close an
        // open task input: otherwise the stale typed text would be submitted
        // against the new element. Unlike syside's array-valued qualified
        // name, the subject is a primitive string, so plain value equality is
        // the right guard: a re-commit of the same element's string keeps the
        // draft, any other string (new element, synthetic id of an unnamed
        // one) closes it. (Unchanged re-commits never even reach this hook —
        // Lit's default hasChanged compares with Object.is.)
        if (changedProperties.has("subject") || changedProperties.has("filepath")) {
          this.closeInput();
        }
      }

      // Deliberately the unparameterized PropertyValues here (vs.
      // PropertyValues<this> in willUpdate): the only key consulted is the
      // private `editing`, which TypeScript's `keyof` excludes, so the typed
      // form would reject the lookup.
      protected override updated(changedProperties: PropertyValues): void {
        // Only focus after the open-input update committed, at which point the
        // input's `is-visible` class makes it rendered (display: block) and
        // focusable.
        if (changedProperties.has("editing") && this.editing) {
          this.inputRef.value?.focus();
        }
      }

      protected override render(): TemplateResult {
        return html`
          <div class="palette" role="group" aria-label="Element actions">
            <button type="button" class="palette-copy-name" aria-label="Copy element name" @click=${this.onCopyNameClick}>${copyIconSvg}<span>Copy name</span></button>
            <button type="button" class="palette-investigate" aria-label="Investigate element" @click=${this.onInvestigateClick}>${investigateIconSvg}<span>Investigate</span></button>
            <button type="button" class="palette-task" aria-label="Custom task for element" @click=${this.onTaskClick}>${taskIconSvg}<span>Task</span></button>
            <input
              type="text"
              class=${classMap({ "palette-input": true, "is-visible": this.editing })}
              aria-label="Task for element"
              placeholder="Task for element"
              @keydown=${this.onInputKeydown}
              @blur=${this.onInputBlur}
              ${ref(this.inputRef)}
            />
          </div>
        `;
      }

      /** The panel always binds a defined subject; the empty guard keeps a
       *  detached/mis-mounted palette from inserting a broken prompt instead.
       *  Returns the non-empty subject, or undefined to skip the action. */
      private boundSubject(): string | undefined {
        const subject = this.subject;
        return subject === undefined || subject === "" ? undefined : subject;
      }

      private onInvestigateClick = (): void => {
        const subject = this.boundSubject();
        if (subject === undefined) return;
        insertInvestigatePrompt(this.context?.prompt, this.filepath, subject);
      };

      private onCopyNameClick = (): void => {
        const subject = this.boundSubject();
        if (subject === undefined) return;
        insertCopyNamePrompt(this.context?.prompt, subject);
      };

      private onTaskClick = (): void => {
        if (this.editing) {
          // Reselection with the input already open: refocus and clear so the
          // user can start a new task.
          const input = this.inputRef.value;
          if (input !== undefined) {
            input.value = "";
            input.focus();
          }
          return;
        }
        this.openInput();
      };

      private onInputKeydown = (event: KeyboardEvent): void => {
        if (event.key === "Enter") {
          const task = this.inputRef.value?.value.trim() ?? "";
          const subject = this.boundSubject();
          if (task === "" || subject === undefined) return;
          insertTaskPrompt(this.context?.prompt, this.filepath, subject, task);
          this.closeInput();
        } else if (event.key === "Escape") {
          this.closeInput();
        }
      };

      private onInputBlur = (event: FocusEvent): void => {
        const related = event.relatedTarget;
        if (related instanceof Node && this.renderRoot.contains(related)) return;
        this.closeInput();
      };

      private openInput(): void {
        this.editing = true;
        const input = this.inputRef.value;
        if (input !== undefined) input.value = "";
      }

      private closeInput(): void {
        if (!this.editing) return;
        this.editing = false;
        const input = this.inputRef.value;
        if (input !== undefined) input.value = "";
      }
    }
    customElements.define(actionPaletteElementTag, OpenseActionPaletteElement);
  });
}