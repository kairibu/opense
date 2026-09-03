// @vitest-environment happy-dom
//
// Element-level tests for the Phase 3 Lit panel elements
// (opense-panel-elements.ts), per plan §5: drive the controller directly
// (DOM-free state logic is covered by opense-panel-controller.test.ts) and
// reserve these for template/event wiring — shadow-root content, the
// activity element's status strip, and the body's controller lifecycle
// wiring through its nested activity element.
//
// The controller host is the minimal mutable flag holder
// (`{isConnected}` — deliberately NOT a LitElement: the controller writes
// the flag, and a real LitElement's read-only getter would not accept the
// assignment, Phase 2 reviewer heads-up). The body mirrors controller state
// into its reactive properties exactly like the panel render wiring does
// (opense-panel.ts renderOpensePanel): `bindBody` below stands in for the
// host template's property bindings.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { OpenseWorkspaceController } from "./opense-panel-controller.js";
import { parseOpenseWorkspace } from "./opense-panel.js";
import type { OpenseActionPaletteElement } from "./opense-panel-palette.js";
import {
  activityElementTag,
  bodyElementTag,
  defineOpensePanelElements,
  type OpensePanelActivityElement,
  type OpensePanelBodyElement,
} from "./opense-panel-elements.js";
import { createFakeFiles, fileEntry, text, tree } from "./test-support.js";

const openseWorkspace: Workspace = {
  id: "workspace-1",
  projectId: "project-1",
  path: "/repo",
  label: "main",
  isMain: true,
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("OpensePanelActivityElement (status strip)", () => {
  it("renders the stale badge, ok/issues chip, and error alert from its reactive props, and clears when they reset", async () => {
    defineOpensePanelElements();
    const el = document.createElement(activityElementTag) as OpensePanelActivityElement;
    document.body.append(el);
    await el.updateComplete;
    expect(el.shadowRoot?.textContent?.trim() ?? "").toBe("");

    el.stale = true;
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".opense-stale")?.textContent).toBe("stale");

    el.reportOk = false;
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".opense-status.issues")?.textContent).toBe("issues");

    el.reportOk = true;
    await el.updateComplete;
    const ok = el.shadowRoot?.querySelector(".opense-status.ok");
    expect(ok?.textContent).toBe("ok");
    expect(el.shadowRoot?.querySelector(".opense-status.issues")).toBeNull();

    // `loading` is not painted (the Parse button and the body's "Parsing
    // workspace…" empty state carry the visible loading story), but it does
    // drive the strip's aria-busy — the chip verdict is announced as pending
    // while a parse runs, which is the property's one observable use.
    el.loading = true;
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".opense-strip")?.getAttribute("aria-busy")).toBe("true");
    el.loading = false;
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".opense-strip")?.getAttribute("aria-busy")).toBe("false");

    el.error = "Parser crashed";
    await el.updateComplete;
    const alert = el.shadowRoot?.querySelector<HTMLElement>(".opense-error[role=alert]");
    expect(alert?.textContent).toBe("Parser crashed");

    // A clean re-render resets the strip (re-parse landed, no error).
    el.stale = false;
    el.reportOk = undefined;
    el.error = undefined;
    await el.updateComplete;
    expect(el.shadowRoot?.textContent?.trim() ?? "").toBe("");
  });

  it("drives the controller lifecycle: connect raises the flag, controller swap drops the old and connects the new, disconnect drops", async () => {
    defineOpensePanelElements();
    // Empty-but-valid trees: the parse job completes with a zero-row report
    // (discovery on a missing root would reject instead).
    const emptyContext = panelContext(createFakeFiles({ trees: { "": tree([]) } })).context;
    const controllerA = new OpenseWorkspaceController({ isConnected: false }, emptyContext, parseOpenseWorkspace);
    const controllerB = new OpenseWorkspaceController({ isConnected: false }, panelContext(createFakeFiles({ trees: { "": tree([]) } })).context, parseOpenseWorkspace);
    expect(controllerA.host.isConnected).toBe(false);

    const el = document.createElement(activityElementTag) as OpensePanelActivityElement;
    el.controller = controllerA;
    document.body.append(el);
    await el.updateComplete;
    await settle();
    expect(controllerA.host.isConnected).toBe(true);
    // The very first parse was kicked by the connect path (fake files parse
    // serves no rows, but the job runs — flag + requestRender proof enough).
    expect(controllerA.loading).toBe(false);
    expect(controllerA.result?.report.parsedFileCount).toBe(0);

    // Workspace switch while connected: the host commits a different
    // controller — the old workspace's flag drops, the new one's rises, and
    // the swapped-in controller actually runs its own parse job (not just the
    // flag): same empty-tree report as controllerA's, loading back to false.
    el.controller = controllerB;
    await el.updateComplete;
    expect(controllerA.host.isConnected).toBe(false);
    expect(controllerB.host.isConnected).toBe(true);
    await settle();
    expect(controllerB.loading).toBe(false);
    expect(controllerB.result?.report.parsedFileCount).toBe(0);

    // Panel switch-away: the disconnected callback lowers the flag so late
    // async writes are dropped (§3.2).
    el.remove();
    expect(controllerB.host.isConnected).toBe(false);
  });
});

describe("OpensePanelBodyElement (panel root)", () => {
  it("kicks the parse through its nested activity and renders outline, selection, and details", async () => {
    defineOpensePanelElements();
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("model.sysml", "model.sysml")]) },
      reads: { "model.sysml": text("package Tracker {\n  package Parts { part lens : LensCell; }\n}") },
    });
    const { context, requestRender } = panelContext(files);
    const host = { isConnected: false };
    const controller = new OpenseWorkspaceController(host, context, parseOpenseWorkspace);

    const body = document.createElement(bodyElementTag) as OpensePanelBodyElement;
    bindBody(body, controller, context);
    document.body.append(body);
    // The body's first shadow render mounts the activity, whose connect path
    // raises the host flag and starts the parse.
    await body.updateComplete;
    expect(host.isConnected).toBe(true);
    expect(controller.loading).toBe(true);
    expect(requestRender).toHaveBeenCalled();

    // Re-mirror after the parse lands (the panel render wiring's job; here
    // the test plays the host template).
    await settle();
    bindBody(body, controller, context);
    await flushElements(body);

    const root = body.shadowRoot;
    if (root === null) throw new Error("Expected the body shadow root");
    expect(root.textContent).toContain("Tracker");
    expect(root.textContent).toContain("lens");
    // Status strip: clean parse, ok.
    const activity = root.querySelector(activityElementTag) as OpensePanelActivityElement | null;
    expect(activity?.shadowRoot?.querySelector(".opense-status.ok")?.textContent).toBe("ok");

    // Selecting the lens outline row drives the controller's action surface.
    const lensRow = [...root.querySelectorAll("button")].find((candidate) => candidate.textContent.includes("lens"));
    if (lensRow === undefined) throw new Error("Expected the lens outline row");
    lensRow.click();
    expect(controller.selectedId).toBe(lensRow.getAttribute("data-id"));

    bindBody(body, controller, context);
    await flushElements(body);
    const detail = root.querySelector(".opense-detail");
    expect(detail?.textContent).toContain("Tracker::Parts::lens");
    expect(detail?.textContent).toContain("TypeLensCell");
    // The detail pane carries the action palette bound to this context and
    // the selected element's subject (property bindings — no attributes).
    const palette = root.querySelector<OpenseActionPaletteElement>("pi-web-opense-action-palette");
    expect(palette?.context).toBe(context);
    expect(palette?.subject).toBe("Tracker::Parts::lens");
  });

  it("surfaces a rejected parse as the status strip's error alert", async () => {
    defineOpensePanelElements();
    const { context } = panelContext(createFakeFiles());
    const controller = new OpenseWorkspaceController(
      { isConnected: false },
      context,
      async () => { throw new Error("Parser crashed"); },
    );

    const body = document.createElement(bodyElementTag) as OpensePanelBodyElement;
    bindBody(body, controller, context);
    document.body.append(body);
    await body.updateComplete;
    await settle();
    await flushElements(body);
    expect(controller.error).toBe("Parser crashed");

    bindBody(body, controller, context);
    await flushElements(body);
    const activity = body.shadowRoot?.querySelector(activityElementTag) as OpensePanelActivityElement | null;
    const alert = activity?.shadowRoot?.querySelector<HTMLElement>(".opense-error[role=alert]");
    expect(alert?.textContent).toBe("Parser crashed");
    // No report yet: the body keeps the pre-result copy.
    expect(body.shadowRoot?.textContent).toContain("Run Parse to build the model outline.");
  });
});

/** Stand-in for the panel render wiring's property bindings (opense-panel.ts
 *  renderOpensePanel): mirrors the controller's render inputs onto the body
 *  element exactly as the host template does. */
function bindBody(
  body: OpensePanelBodyElement,
  controller: OpenseWorkspaceController,
  context: WorkspacePanelContext,
): void {
  body.controller = controller;
  body.context = context;
  body.result = controller.result;
  body.loading = controller.loading;
  body.stale = controller.stale;
  body.error = controller.error;
  body.selectedId = controller.selectedId;
  body.kindFilter = controller.kindFilter;
}

async function flushElements(body: OpensePanelBodyElement): Promise<void> {
  await body.updateComplete;
  const activity = body.shadowRoot?.querySelector(activityElementTag) as OpensePanelActivityElement | null;
  await activity?.updateComplete;
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function panelContext(fake: ReturnType<typeof createFakeFiles>): { context: WorkspacePanelContext; requestRender: ReturnType<typeof vi.fn> } {
  const requestRender = vi.fn();
  const files = fake.files;
  const noop = () => undefined;
  const context: WorkspacePanelContext = {
    machine: { id: "local", name: "local", kind: "local" },
    workspace: openseWorkspace,
    state: { selectedWorkspace: openseWorkspace, workspaceTool: "opense:workspace.opense", mainView: "opense:workspace.opense" },
    files,
    host: { requestRender },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    terminal: { open: noop, runCommand: () => Promise.reject(new Error("not implemented")) },
  };
  return { context, requestRender };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}