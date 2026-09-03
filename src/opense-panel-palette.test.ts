// @vitest-environment happy-dom
//
// Action palette element (opense-panel-palette.ts), adapted from the syside
// palette test (pi-web-plugins/syside/browser/syside-panel-palette.test.ts):
// real mount + interaction over the shadow root, insertions asserted through
// a fake WorkspacePanelContext prompt editor.
//
// The palette is a LitElement, so its reactive updates are async-batched:
// every assertion on `editing`-derived DOM (the task input's `is-visible`
// class) must follow `await el.updateComplete` after the event or property
// change that scheduled it.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import {
  actionPaletteElementTag,
  defineOpenseActionPaletteElement,
  type OpenseActionPaletteElement,
} from "./opense-panel-palette.js";

declare global {
  interface HTMLElementTagNameMap {
    "pi-web-opense-action-palette": OpenseActionPaletteElement;
  }
}

function makeContext(insertText?: (text: string) => void): WorkspacePanelContext {
  return {
    machine: { id: "m1", name: "test", kind: "local" },
    workspace: {
      projectId: "p1",
      id: "ws1",
      path: "/home/test/proj",
      label: "Test",
      isMain: true,
    },
    prompt: {
      insertText: insertText ?? vi.fn(),
      getText() {
        return "";
      },
      getSelection() {
        return null;
      },
    },
    terminal: {
      open: vi.fn(),
      runCommand: vi.fn(),
    },
    files: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      deleteFile: vi.fn(),
      moveFile: vi.fn(),
      listFiles: vi.fn(),
    },
    host: {
      requestRender: vi.fn(),
    },
  };
}

async function mountPalette(
  subject: string | undefined,
  filepath: string | undefined,
  context: WorkspacePanelContext,
): Promise<OpenseActionPaletteElement> {
  defineOpenseActionPaletteElement();
  const el = document.createElement(actionPaletteElementTag);
  el.subject = subject;
  el.filepath = filepath;
  el.context = context;
  document.body.appendChild(el);
  // First render is a microtask after connect; wait for the shadow DOM.
  await el.updateComplete;
  return el;
}

function taskInput(el: OpenseActionPaletteElement): HTMLInputElement {
  const input = el.shadowRoot?.querySelector<HTMLInputElement>(".palette-input");
  if (input === null || input === undefined) throw new Error("No task input in palette shadow root");
  return input;
}

function paletteButton(el: OpenseActionPaletteElement, className: string): HTMLButtonElement {
  const button = el.shadowRoot?.querySelector<HTMLButtonElement>(`.${className}`);
  if (button === null || button === undefined) throw new Error(`No ${className} button in palette shadow root`);
  return button;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("OpenseActionPalette", () => {
  it("inserts the fixed investigation prompt on Investigate click", async () => {
    const insertText = vi.fn();
    const el = await mountPalette("Tracker::Parts::lens", "model/good.sysml", makeContext(insertText));

    paletteButton(el, "palette-investigate").click();

    expect(insertText).toHaveBeenCalledWith(
      "Investigate Tracker::Parts::lens and summarise its structure, behaviour, and requirements. The element is located in model/good.sysml",
    );
  });

  it("omits the location clause when no declaring file is bound", async () => {
    const insertText = vi.fn();
    const el = await mountPalette("Tracker::Parts::lens", undefined, makeContext(insertText));

    paletteButton(el, "palette-investigate").click();

    expect(insertText).toHaveBeenCalledWith(
      "Investigate Tracker::Parts::lens and summarise its structure, behaviour, and requirements.",
    );
  });

  it("inserts the subject on Copy name click", async () => {
    const insertText = vi.fn();
    const el = await mountPalette("Tracker::Parts::lens", "model/good.sysml", makeContext(insertText));

    paletteButton(el, "palette-copy-name").click();

    // Bare subject only — no Investigate sentence, no location clause.
    expect(insertText).toHaveBeenCalledWith("Tracker::Parts::lens");
  });

  it("reveals the task input on Task click without inserting", async () => {
    const insertText = vi.fn();
    const el = await mountPalette("Tracker::Parts::lens", "model/good.sysml", makeContext(insertText));

    paletteButton(el, "palette-task").click();
    await el.updateComplete;

    expect(insertText).not.toHaveBeenCalled();
    expect(taskInput(el).classList.contains("is-visible")).toBe(true);
  });

  it("Enter inserts the edit prompt and hides the input", async () => {
    const insertText = vi.fn();
    const el = await mountPalette("Tracker::Parts::lens", "model/good.sysml", makeContext(insertText));
    paletteButton(el, "palette-task").click();
    await el.updateComplete;

    const input = taskInput(el);
    input.value = "Add validation";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await el.updateComplete;

    expect(insertText).toHaveBeenCalledWith(
      'Perform task "Add validation" for element Tracker::Parts::lens. The element is located in model/good.sysml',
    );
    expect(input.classList.contains("is-visible")).toBe(false);
  });

  it("does not insert for an empty or whitespace task on Enter", async () => {
    const insertText = vi.fn();
    const el = await mountPalette("Tracker::Parts::lens", "model/good.sysml", makeContext(insertText));
    paletteButton(el, "palette-task").click();
    await el.updateComplete;

    const input = taskInput(el);
    input.value = "   ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(insertText).not.toHaveBeenCalled();
    expect(input.classList.contains("is-visible")).toBe(true);
  });

  it("Escape hides the input without inserting", async () => {
    const insertText = vi.fn();
    const el = await mountPalette("Tracker::Parts::lens", "model/good.sysml", makeContext(insertText));
    paletteButton(el, "palette-task").click();
    await el.updateComplete;

    const input = taskInput(el);
    input.value = "Discard me";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await el.updateComplete;

    expect(insertText).not.toHaveBeenCalled();
    expect(input.classList.contains("is-visible")).toBe(false);
  });

  it("blur hides the input without inserting", async () => {
    const insertText = vi.fn();
    const el = await mountPalette("Tracker::Parts::lens", "model/good.sysml", makeContext(insertText));
    paletteButton(el, "palette-task").click();
    await el.updateComplete;

    const input = taskInput(el);
    input.value = "Discard me";
    input.dispatchEvent(new FocusEvent("blur"));
    await el.updateComplete;

    expect(insertText).not.toHaveBeenCalled();
    expect(input.classList.contains("is-visible")).toBe(false);
  });

  it("keeps the input open when focus moves to Investigate and inserts on click", async () => {
    const insertText = vi.fn();
    const el = await mountPalette("Tracker::Parts::lens", "model/good.sysml", makeContext(insertText));
    paletteButton(el, "palette-task").click();
    await el.updateComplete;

    const input = taskInput(el);
    const investigate = paletteButton(el, "palette-investigate");
    // Focus moving to the sibling Investigate button (inside the shadow root)
    // must not blur-close the open input — the blur handler returns early when
    // the new focus target is still contained by the render root.
    input.dispatchEvent(new FocusEvent("blur", { relatedTarget: investigate }));

    expect(input.classList.contains("is-visible")).toBe(true);
    investigate.click();
    expect(insertText).toHaveBeenCalledTimes(1);
    expect(input.classList.contains("is-visible")).toBe(true);
  });

  it("keeps the input open when focus moves to Copy name and inserts on click", async () => {
    const insertText = vi.fn();
    const el = await mountPalette("Tracker::Parts::lens", "model/good.sysml", makeContext(insertText));
    paletteButton(el, "palette-task").click();
    await el.updateComplete;

    const input = taskInput(el);
    const copyName = paletteButton(el, "palette-copy-name");
    // Mirror of the Investigate case: focus moving to the sibling Copy name
    // button (inside the shadow root) must not blur-close the open input.
    input.dispatchEvent(new FocusEvent("blur", { relatedTarget: copyName }));

    expect(input.classList.contains("is-visible")).toBe(true);
    copyName.click();
    expect(insertText).toHaveBeenCalledTimes(1);
    expect(insertText).toHaveBeenCalledWith("Tracker::Parts::lens");
    expect(input.classList.contains("is-visible")).toBe(true);
  });

  it("reselecting Task with the input open clears and refocuses it", async () => {
    const insertText = vi.fn();
    const el = await mountPalette("Tracker::Parts::lens", "model/good.sysml", makeContext(insertText));
    paletteButton(el, "palette-task").click();
    await el.updateComplete;

    const input = taskInput(el);
    input.value = "Stale task";
    paletteButton(el, "palette-task").click();

    expect(input.value).toBe("");
    expect(input.classList.contains("is-visible")).toBe(true);
    expect(insertText).not.toHaveBeenCalled();
  });

  it("closes the open task input when the element changes", async () => {
    const insertText = vi.fn();
    const el = await mountPalette("Tracker::Parts::lens", "model/good.sysml", makeContext(insertText));
    paletteButton(el, "palette-task").click();
    await el.updateComplete;
    const input = taskInput(el);
    input.value = "Stale task";
    expect(input.classList.contains("is-visible")).toBe(true);

    // The host reuses the same palette node across element selections; a new
    // subject must drop the stale draft so it is never submitted against the
    // new element. (String value equality is the identity guard here.)
    el.subject = "Tracker::Parts::aperture";
    await el.updateComplete;

    expect(input.classList.contains("is-visible")).toBe(false);
    expect(input.value).toBe("");
  });

  it("closes the open task input when switching to an unnamed element's synthetic id", async () => {
    const insertText = vi.fn();
    const el = await mountPalette("Tracker::'needs focus'", "model.sysml", makeContext(insertText));
    paletteButton(el, "palette-task").click();
    await el.updateComplete;

    const input = taskInput(el);
    input.value = "Stale task";
    // The unnamed doc's synthetic index id is a different string, so the
    // draft must not survive the selection change.
    el.subject = "Tracker::'needs focus'::<doc>";
    await el.updateComplete;

    expect(input.classList.contains("is-visible")).toBe(false);
    expect(input.value).toBe("");
  });

  it("keeps the open task input when the same element is re-committed", async () => {
    const insertText = vi.fn();
    const el = await mountPalette("Tracker::Parts::lens", "model/good.sysml", makeContext(insertText));
    paletteButton(el, "palette-task").click();
    await el.updateComplete;
    const input = taskInput(el);
    input.value = "Keep me";

    // lit-html re-commits property parts on every render; Lit's hasChanged
    // compares with Object.is. The subject is a primitive string, so the
    // equal re-commit keeps the open draft (no update is even scheduled).
    el.subject = "Tracker::Parts::lens";
    el.filepath = "model/good.sysml";

    expect(input.classList.contains("is-visible")).toBe(true);
    expect(input.value).toBe("Keep me");
  });

  it("re-registers only once and no-ops its buttons without a subject", async () => {
    const insertText = vi.fn();
    const el = await mountPalette(undefined, undefined, makeContext(insertText));

    // A detached/mis-mounted palette must not insert broken prompts.
    paletteButton(el, "palette-investigate").click();
    paletteButton(el, "palette-copy-name").click();

    expect(insertText).not.toHaveBeenCalled();

    // Calling the definition again is a no-op (same element class stays).
    defineOpenseActionPaletteElement();
    expect(customElements.get(actionPaletteElementTag)).toBeDefined();
  });
});