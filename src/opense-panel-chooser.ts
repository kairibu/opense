// ---------------------------------------------------------------------------
// C2 (plan-v5 §2.C): the chat-side reference chooser overlay. When a message
// carries SEVERAL OpenSE element candidates, the message action's `run`
// opens this overlay instead of navigating immediately; picking a row
// navigates, Escape or a backdrop click closes without navigating.
//
// Design note (chooser adaptation): the plan suggested reusing the action
// palette element as the chooser, but that element renders below the
// element-detail pane and is driven by the panel's render wiring — forcing
// chat-overlay duty onto it would be invasive. This module is the minimal
// alternative the plan allows: a dedicated tiny Lit element appended to
// `document.body` (the message-action context exposes no DOM anchor), with
// the register-once idiom (opense-shared.ts) and the panel styles' CSS
// variable palette. It stays out of opense-references.ts so that module
// remains pure (no DOM), and out of opense-panel.ts to keep the wiring
// module small.
//
// Lit-based element (LitElement + reactive properties + declarative event
// bindings + scoped static styles), same contract as the action palette:
// driven entirely via property bindings, safe to register more than once
// through `defineCustomElementOnce`.
// ---------------------------------------------------------------------------

import { LitElement, css, html, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { openseReferenceLabel } from "./opense-references.js";
import { defineCustomElementOnce } from "./opense-shared.js";

export const referenceChooserElementTag = "pi-web-opense-reference-chooser";

/**
 * Public property surface of the reference chooser custom element. Host code
 * (the message action's `run`) and tests use this type for property bindings
 * and typed DOM lookups.
 */
export interface OpenseReferenceChooserElement extends LitElement {
  /** Candidates to offer, in extraction order (never empty when opened). */
  candidates: string[];
  /** Invoked with the picked candidate; undefined until the host binds it. */
  onPick: ((candidate: string) => void) | undefined;
  /** Invoked on Escape / backdrop click; undefined until the host binds it. */
  onClose: (() => void) | undefined;
}

/** Options for `openOpenseReferenceChooser`. */
export interface OpenseReferenceChooserOptions {
  candidates: string[];
  /** Called after the chooser closed itself over the picked row. */
  onPick: (candidate: string) => void;
}

/** The currently-open chooser's close handle (module state): one overlay
 *  at a time, and the activation-dispose path below reaches it. A stale
 *  handle is harmless — `close` is idempotent and its element detached. */
let openChooserClose: (() => void) | undefined;

/**
 * Open the reference chooser overlay and return its close function. Creates
 * the element, binds pick/close (both clean the element up first, so a pick
 * never re-enters a closing path), appends it to `document.body`, and
 * focuses the first row. The returned function is idempotent — closing an
 * already-closed chooser is a no-op — so callers can also use it as a
 * cleanup handle.
 *
 * One overlay at a time (review fix): the host chat has a single focus
 * context, so a second open while one is open CLOSES THE FIRST instead of
 * stacking a second backdrop/Escape trap over it.
 */
export function openOpenseReferenceChooser(options: OpenseReferenceChooserOptions): () => void {
  openChooserClose?.();
  defineOpenseReferenceChooserElement();
  const chooser = document.createElement(referenceChooserElementTag) as OpenseReferenceChooserElement;
  chooser.candidates = options.candidates;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (openChooserClose === close) openChooserClose = undefined;
    chooser.onPick = undefined;
    chooser.onClose = undefined;
    chooser.remove();
  };
  chooser.onClose = close;
  chooser.onPick = (candidate: string): void => {
    close();
    options.onPick(candidate);
  };
  document.body.append(chooser);
  openChooserClose = close;
  return close;
}

/**
 * Close the open reference-chooser overlay, if any. The activation dispose
 * path (opense-panel.ts) calls this so an overlay opened by the message
 * action never outlives the plugin's activation.
 */
export function closeOpenseReferenceChooser(): void {
  openChooserClose?.();
  openChooserClose = undefined;
}

/**
 * Register the chooser custom element. Safe to call more than once on the
 * same page: it re-registers only when the custom element is not defined
 * yet.
 */
export function defineOpenseReferenceChooserElement(): void {
  defineCustomElementOnce(referenceChooserElementTag, () => {
    class OpenseReferenceChooserElement extends LitElement {
      /** Reactive property bindings from the opener; never reflected to
       *  attributes (the chooser is driven entirely via properties). */
      @property({ attribute: false })
      candidates: string[] = [];

      @property({ attribute: false })
      onPick: ((candidate: string) => void) | undefined;

      @property({ attribute: false })
      onClose: (() => void) | undefined;

      static override styles = css`
        :host {
          position: fixed;
          inset: 0;
          z-index: 1000;
        }

        .opense-chooser-backdrop {
          position: absolute;
          inset: 0;
          background: rgba(0, 0, 0, 0.4);
          display: flex;
          align-items: flex-start;
          justify-content: center;
          padding-top: 15vh;
        }

        .opense-chooser {
          background: var(--pi-surface);
          border: 1px solid var(--pi-border);
          border-radius: 8px;
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
          display: flex;
          flex-direction: column;
          min-width: 280px;
          max-width: 70vw;
          max-height: 60vh;
          overflow: auto;
          padding: 4px;
        }

        .opense-chooser button {
          all: unset;
          box-sizing: border-box;
          cursor: pointer;
          display: block;
          width: 100%;
          padding: 6px 10px;
          border-radius: 4px;
          color: var(--pi-text);
          font-size: 13px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .opense-chooser button:hover,
        .opense-chooser button:focus-visible {
          background: var(--pi-selection-bg);
          color: var(--pi-selection-text);
        }
      `;

      /** Escape closes the chooser from anywhere — the listener is
       *  document-level and capturing so it also wins while focus remains
       *  in the host app's composer. */
      private readonly handleKeydown = (event: KeyboardEvent): void => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        this.onClose?.();
      };

      override connectedCallback(): void {
        super.connectedCallback();
        document.addEventListener("keydown", this.handleKeydown, true);
      }

      override disconnectedCallback(): void {
        document.removeEventListener("keydown", this.handleKeydown, true);
        super.disconnectedCallback();
      }

      protected override firstUpdated(): void {
        this.renderRoot.querySelector("button")?.focus();
      }

      protected override render(): TemplateResult {
        return html`
          <div
            class="opense-chooser-backdrop"
            role="presentation"
            @click=${(): void => { this.onClose?.(); }}
          >
            <div
              class="opense-chooser"
              role="dialog"
              aria-modal="true"
              aria-label="Open element in OpenSE"
              @click=${this.stopPropagation}
            >
              ${this.candidates.map((candidate) => html`
                <button
                  type="button"
                  @click=${(): void => { this.onPick?.(candidate); }}
                >${openseReferenceLabel(candidate)}</button>
              `)}
            </div>
          </div>
        `;
      }

      /** A click inside the dialog must not bubble to the backdrop's
       *  close-on-click handler. */
      private stopPropagation(event: Event): void {
        event.stopPropagation();
      }
    }
    customElements.define(referenceChooserElementTag, OpenseReferenceChooserElement);
  });
}
