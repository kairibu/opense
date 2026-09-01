// ---------------------------------------------------------------------------
// OpenSE element action palette: a vanilla custom element rendered below the
// element-detail pane offering Investigate (lightbulb), Task (pencil), and
// Copy name (copy) actions for the selected element. Direct adaptation of the
// syside palette (pi-web-plugins/syside/browser/syside-panel-palette.ts),
// simplified for opense's data model: the subject is one display string
// (qualified name, falling back to name/id) instead of a qualified-name
// segment array, and the optional location is the element's declaring file.
//
// Purely imperative (no Lit), because plugin modules load without an import
// map and a shadow root is cheap to build by hand — same reason the panel's
// activity element is vanilla.
// ---------------------------------------------------------------------------

import type { PluginPromptEditor, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { contextPrompt, editPrompt } from "./opense-prompts.js";
import { defineCustomElementOnce } from "./opense-shared.js";

export const actionPaletteElementTag = "pi-web-opense-action-palette";

/**
 * Public property surface of the action palette custom element. Host code and
 * tests use this type for property bindings and typed DOM lookups.
 */
export interface OpenseActionPaletteElement extends HTMLElement {
  /** Display string addressing the element in prompts (never empty). */
  subject: string | undefined;
  filepath: string | undefined;
  context: WorkspacePanelContext | undefined;
}

/**
 * Toolbar icon for the fixed "Investigate" action (lightbulb). Rendered as a
 * static SVG string (no import map for plugin modules, so no template
 * literal) with `aria-hidden` because each use is paired with a real
 * `aria-label` button.
 */
export const investigateIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>`;

/**
 * Toolbar icon for the custom "Task" action (pencil with sparkles). Same
 * accessibility contract as `investigateIconSvg`.
 */
export const taskIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3H8"/><path d="m15.007 5.008 3.987 3.986"/><path d="M20 15v4"/><path d="M21.174 6.813a2.82 2.82 0 0 0-3.986-3.987L3.842 16.175a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="M22 17h-4"/><path d="M4 5v4"/><path d="M6 7H2"/><path d="M9 2v2"/></svg>`;

/**
 * Toolbar icon for the "Copy name" action (two overlapping rounded rects).
 * Same accessibility contract as the other icons.
 */
export const copyIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;

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

const PALETTE_STYLES = `
  :host {
    display: block;
  }

  .palette {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .palette button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: var(--pi-surface-hover);
    border: 1px solid var(--pi-border);
    border-radius: 6px;
    padding: 4px 8px;
    cursor: pointer;
    color: var(--pi-text-secondary);
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
`;

/**
 * Vanilla custom element providing horizontal Copy name, Investigate, and
 * Task controls plus a conditional inline task input, for the selected
 * element in the OpenSE detail pane. The Investigate button inserts a fixed
 * investigation prompt; the Copy name button inserts the bare subject string;
 * the Task button opens an inline input whose submitted text is inserted as a
 * custom prompt.
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
    class OpenseActionPaletteElement extends HTMLElement {
      private subjectValue: string | undefined;
      private filepathValue: string | undefined;
      private contextValue: WorkspacePanelContext | undefined;
      private editing = false;
      private shadow: ShadowRoot | undefined;
      private input: HTMLInputElement | undefined;

      // lit-html 3.x re-commits object property parts on every render, so these
      // setters fire even when their value is unchanged. They must stay cheap,
      // storing the value for the click/keydown handlers below.
      //
      // The host reuses the same palette DOM node across element selections, so
      // a genuinely changed element identity must close an open task input:
      // otherwise the stale typed text would be submitted against the new
      // element. Unlike syside's array-valued qualified name, the subject is a
      // primitive string, so plain value equality is the right guard: a
      // re-commit of the same element's string keeps the draft, any other
      // string (new element, synthetic id of an unnamed one) closes it.
      set subject(value: string | undefined) {
        if (value !== this.subjectValue) {
          this.subjectValue = value;
          this.closeInput();
        }
      }

      get subject(): string | undefined {
        return this.subjectValue;
      }

      set filepath(value: string | undefined) {
        if (value !== this.filepathValue) {
          this.filepathValue = value;
          this.closeInput();
        }
      }

      get filepath(): string | undefined {
        return this.filepathValue;
      }

      set context(value: WorkspacePanelContext | undefined) {
        this.contextValue = value;
      }

      get context(): WorkspacePanelContext | undefined {
        return this.contextValue;
      }

      connectedCallback(): void {
        if (this.shadow !== undefined) return;
        const shadow = this.attachShadow({ mode: "open" });
        this.shadow = shadow;
        shadow.innerHTML = `
          <style>${PALETTE_STYLES}</style>
          <div class="palette" role="group" aria-label="Element actions">
            <button type="button" class="palette-copy-name" aria-label="Copy element name">${copyIconSvg}<span>Copy name</span></button>
            <button type="button" class="palette-investigate" aria-label="Investigate element">${investigateIconSvg}<span>Investigate</span></button>
            <button type="button" class="palette-task" aria-label="Custom task for element">${taskIconSvg}<span>Task</span></button>
            <input type="text" class="palette-input" aria-label="Task for element" placeholder="Task for element" />
          </div>
        `;

        const input = shadow.querySelector<HTMLInputElement>(".palette-input");
        this.input = input ?? undefined;

        // The panel always binds a defined subject; the shared empty guard keeps
        // a detached/mis-mounted palette from inserting a broken prompt instead.
        shadow.querySelector<HTMLButtonElement>(".palette-investigate")?.addEventListener("click", this.withSubject((subject) => {
          insertInvestigatePrompt(this.contextValue?.prompt, this.filepathValue, subject);
        }));

        shadow.querySelector<HTMLButtonElement>(".palette-task")?.addEventListener("click", () => {
          if (this.editing) {
            // Reselection with the input already open: refocus and clear so the
            // user can start a new task.
            if (this.input !== undefined) {
              this.input.value = "";
              this.input.focus();
            }
            return;
          }
          this.openInput();
        });

        shadow.querySelector<HTMLButtonElement>(".palette-copy-name")?.addEventListener("click", this.withSubject((subject) => {
          insertCopyNamePrompt(this.contextValue?.prompt, subject);
        }));

        input?.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter") {
            const task = input.value.trim();
            if (task === "" || this.subjectValue === undefined || this.subjectValue === "") return;
            insertTaskPrompt(this.contextValue?.prompt, this.filepathValue, this.subjectValue, task);
            this.closeInput();
          } else if (e.key === "Escape") {
            this.closeInput();
          }
        });

        input?.addEventListener("blur", (e: FocusEvent) => {
          const related = e.relatedTarget;
          if (related instanceof Node && (this.shadow?.contains(related) ?? false)) return;
          this.closeInput();
        });
      }

      private openInput(): void {
        if (this.input === undefined) return;
        this.editing = true;
        this.input.value = "";
        this.input.classList.add("is-visible");
        this.input.focus();
      }

      private closeInput(): void {
        if (this.input === undefined) return;
        this.editing = false;
        this.input.value = "";
        this.input.classList.remove("is-visible");
      }

      /** Click-handler wrapper sharing the empty-subject guard: the handlers
       *  for subject-addressing actions (Investigate, Copy name) run only when
       *  a non-empty subject is bound; the Task handler manages its own input
       *  state and is wired directly. */
      private withSubject(run: (subject: string) => void): () => void {
        return () => {
          if (this.subjectValue === undefined || this.subjectValue === "") return;
          run(this.subjectValue);
        };
      }
    }
    customElements.define(actionPaletteElementTag, OpenseActionPaletteElement);
  });
}
