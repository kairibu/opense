// @vitest-environment happy-dom
//
// Layer 4 (component boundary): OpenSE workspace panel. Real render +
// interaction through the custom-element/property contract, exactly the git
// panel harness shape (pi-web-plugins/git/pi-web-plugin.test.ts): the
// activity element is connected via document.body, so controller.connect
// drives the first parse; host.requestRender is a noop, so tests re-render
// manually after settling. The parse job runs against a fake files adapter,
// so the whole discovery→loadModel→index→report chain is proven in one
// render test with no backend anywhere.

import { html, render, svg } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FileContentResponse,
  PluginRuntimeContext,
  Workspace,
  WorkspacePanelContext,
} from "@jmfederico/pi-web/plugin-api";
import { createOpenseBrowserContributions } from "./opense-panel.js";
import type { OpenseActionPaletteElement } from "./opense-panel-palette.js";
import {
  createFakeFiles,
  dirEntry,
  fileEntry,
  text,
  tree,
  type FakeWorkspaceFiles,
} from "./test-support.js";

const projectId = "project-1";
const workspaceId = "workspace-1";

const openseWorkspace: Workspace = {
  id: workspaceId,
  projectId,
  path: "/repo",
  label: "main",
  isMain: true,
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("bundled OpenSE browser plugin", () => {
  it("contributes an always-visible panel and two unconditional shortcut actions", async () => {
    const contributions = createOpenseBrowserContributions("opense", html, svg);
    const panel = requiredPanel(contributions);
    const context = panelContext(createFakeFiles({ trees: {} }));

    expect(panel.id).toBe("workspace.opense");
    expect(panel.title).toBe("OpenSE");
    expect(panel.order).toBe(60);
    expect(panel.icon).toBeDefined();
    // Browser-only: no provider ownership, so visibility never gates.
    expect(panel.visible?.(context)).toBe(true);
    expect(panel.visible?.(panelContext(createFakeFiles({ trees: {} }), { ...openseWorkspace, id: "workspace-2" }))).toBe(true);
    expect(typeof panel.onInvalidate).toBe("function");

    const actions = contributions.actions ?? [];
    expect(actions.map(({ id }) => id)).toEqual(["view.opense", "workspace.refresh-opense"]);
    const goToOpense = actions[0];
    const refresh = actions[1];
    expect(goToOpense?.shortcut).toBe("mod+6");
    expect(refresh?.shortcut).toBe("mod+shift+m");
    // Both actions are enabled unconditionally (no `enabled` gate at all).
    expect(goToOpense?.enabled).toBeUndefined();
    expect(refresh?.enabled).toBeUndefined();

    const selectMainView = vi.fn<PluginRuntimeContext["selectMainView"]>();
    const refreshWorkspacePanels = vi.fn<PluginRuntimeContext["refreshWorkspacePanels"]>(() => panel.onInvalidate?.(context));
    const runtime = runtimeContext({ selectMainView, refreshWorkspacePanels });
    await goToOpense?.run(runtime);
    expect(selectMainView).toHaveBeenCalledWith("opense:workspace.opense");

    await refresh?.run(runtime);
    expect(refreshWorkspacePanels).toHaveBeenCalledWith("opense:workspace.opense");
  });

  it("parses the workspace through the fake files adapter and renders diagnostics, outline, and element details", async () => {
    const files = createFakeFiles({
      trees: {
        "": tree([dirEntry("model", "model")]),
        "model": tree([
          fileEntry("unreadable.sysml", "model/unreadable.sysml"),
          fileEntry("bad.sysml", "model/bad.sysml"),
          fileEntry("good.sysml", "model/good.sysml"),
        ]),
      },
      reads: {
        "model/unreadable.sysml": new Error("Permission denied"),
        "model/bad.sysml": text("###"),
        "model/good.sysml": text("package Tracker {\n  package Parts { part lens : LensCell; }\n}"),
      },
    });
    const panel = requiredPanel(createOpenseBrowserContributions("opense", html, svg));
    const insertText = vi.fn();
    const context = panelContext(files, openseWorkspace, "local", insertText);

    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settle();
    render(panel.render(context), container);

    // Toolbar with the Parse (not "Check"/"Validate") button.
    const parseButton = button(container, "Parse");
    expect(parseButton.disabled).toBe(false);

    // Summary badge (report.ok, plan §3.4): the discovery read failure and
    // the parser lexer error make the combined report fail → "issues".
    expect(container.querySelector(".opense-status.issues")?.textContent).toBe("issues");

    // Discovery diagnostic (read failure) first, then the parser's own
    // pre-formatted lexer diagnostic with its path and line:col message.
    const diagnostics = [...container.querySelectorAll(".opense-diagnostic")].map((entry) => entry.textContent);
    // textContent is always a string on DOM nodes; the cast keeps the map callback uniform.
    expect(diagnostics[0]).toContain("error");
    expect(diagnostics[0]).toContain("model/unreadable.sysml");
    expect(diagnostics[0]).toContain("Could not read file: Permission denied");
    expect(diagnostics[1]).toContain("error");
    expect(diagnostics[1]).toContain("model/bad.sysml");
    // `#` lexes as the metadata-annotation Hash token, so `###` surfaces as a
    // parser error (not a lexer error — older bundles predate the Hash token).
    expect(diagnostics[1]).toContain("Parser error");

    // Merged model outline: nesting via indentation, kind labels on rows.
    expect(button(container, "Tracker").textContent).toContain("package");
    const partsRow = button(container, "Parts");
    expect(partsRow.getAttribute("style")).toContain("--depth:1");
    expect(button(container, "lens").getAttribute("style")).toContain("--depth:2");
    expect(container.querySelector(".opense-outline")).not.toBeNull();

    // Vertical layout split: the element list pane must precede the details
    // pane in DOM order (regression guard for the horizontal-vs-vertical axis
    // swap, mirroring the syside panel test pattern).
    const list = container.querySelector(".opense-left");
    const details = container.querySelector(".opense-right");
    expect(list && details && (list.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();

    // Element-detail pane after selecting the lens part.
    button(container, "lens").click();
    render(panel.render(context), container);
    const detail = container.querySelector<HTMLElement>(".opense-detail");
    if (detail === null) throw new Error("Expected the element-detail pane");
    expect(detail.textContent).toContain("part");
    expect(detail.querySelector("h3")?.textContent).toBe("lens");
    expect(detail.textContent).toContain("Tracker::Parts::lens");
    expect(detail.textContent).toContain("Tracker / Parts");
    expect(detail.textContent).toContain("declared in model/good.sysml");
    const fields = [...detail.querySelectorAll(".opense-field")];
    expect(fields.map((field) => field.textContent)).toContain("TypeLensCell");

    // Action palette pinned below the element details (syside prior art):
    // a sibling of the detail section, bound to the selected element's
    // subject and declaring file; Investigate inserts the fixed
    // investigation prompt into the prompt editor.
    const right = container.querySelector<HTMLElement>(".opense-right");
    if (right === null) throw new Error("Expected the details pane");
    const palette = right.querySelector<OpenseActionPaletteElement>("pi-web-opense-action-palette");
    if (palette === null) throw new Error("Expected the action palette below the element details");
    // Pinned-footer layout: the detail section precedes the palette, and the
    // palette is a flex item at the bottom edge of the details pane.
    expect(detail.compareDocumentPosition(palette) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(palette.subject).toBe("Tracker::Parts::lens");
    expect(palette.filepath).toBe("model/good.sysml");
    palette.shadowRoot?.querySelector<HTMLButtonElement>(".palette-copy-name")?.click();
    expect(insertText).toHaveBeenCalledWith("Tracker::Parts::lens");
    palette.shadowRoot?.querySelector<HTMLButtonElement>(".palette-investigate")?.click();
    expect(insertText).toHaveBeenCalledWith(
      "Investigate Tracker::Parts::lens and summarise its structure, behaviour, and requirements. The element is located in model/good.sysml",
    );

    // The Parse button re-runs the job; onInvalidate re-runs it too.
    // One discovery walk lists the root and the nested model/ directory.
    expect(files.listCalls).toEqual(["", "model"]);
    parseButton.click();
    await settle();
    render(panel.render(context), container);
    expect(files.listCalls).toHaveLength(4);
    await panel.onInvalidate?.(context);
    expect(files.listCalls).toHaveLength(6);

    render(null, container);
  });

  it("filters the outline by element kind and clears a filtered-out selection", async () => {
    const files = createFakeFiles({
      trees: {
        "": tree([fileEntry("model.sysml", "model.sysml")]),
      },
      reads: {
        "model.sysml": text("package Tracker {\n  package Parts { part lens : LensCell; }\n}"),
      },
    });
    const panel = requiredPanel(createOpenseBrowserContributions("opense", html, svg));
    const context = panelContext(files);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settle();
    render(panel.render(context), container);

    const kindsRow = container.querySelector<HTMLElement>(".opense-kinds");
    if (kindsRow === null) throw new Error("Expected the kind filter row");
    expect(kindsRow.textContent).toContain("All (2)");
    expect(kindsRow.textContent).toContain("package");
    expect(kindsRow.textContent).toContain("part");

    button(container, "Tracker").click();
    render(panel.render(context), container);
    expect(container.querySelector(".opense-detail")?.textContent).toContain("Tracker");

    button(container, "part").click();
    render(panel.render(context), container);
    // Package rows are filtered out; the selected package cleared accordingly.
    expect(findButton(container, "Tracker")).toBeUndefined();
    expect(findButton(container, "Parts")).toBeUndefined();
    expect(button(container, "lens")).toBeDefined();
    expect(container.textContent).toContain("Select an element in the outline to inspect its details.");

    button(container, "lens").click();
    render(panel.render(context), container);
    expect(container.querySelector(".opense-detail")?.textContent).toContain("Tracker::Parts::lens");

    render(null, container);
  });

  it("hides unnamed elements from the outline and reaches them through owned rows in the detail pane", async () => {
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("model.sysml", "model.sysml")]) },
      reads: {
        "model.sysml": text(
          "package Tracker {\n  requirement 'needs focus' {\n    doc /* must focus */\n    part lens : LensCell;\n  }\n}",
        ),
      },
    });
    const panel = requiredPanel(createOpenseBrowserContributions("opense", html, svg));
    const context = panelContext(files);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settle();
    render(panel.render(context), container);

    // The outline lists named rows only: no italic "doc" row for the
    // requirement's unnamed documentation.
    expect(button(container, "Tracker")).toBeDefined();
    expect(button(container, "needs focus")).toBeDefined();
    expect(button(container, "lens")).toBeDefined();
    expect(findButton(container, "doc")).toBeUndefined();

    // The requirement's detail pane surfaces its owned doc with a preview.
    button(container, "needs focus").click();
    render(panel.render(context), container);
    const owned = container.querySelector(".opense-owned");
    if (owned === null) throw new Error("Expected the owned-elements section");
    expect(owned.textContent).toContain("doc");
    expect(owned.textContent).toContain("must focus");

    // Clicking the owned doc row navigates to the doc's own details (by id),
    // where its full text renders as a curated field.
    const docRow = owned.querySelector<HTMLButtonElement>(".opense-owned-row");
    if (docRow === null) throw new Error("Expected an owned row");
    expect(docRow.dataset["id"]).toBe("Tracker::'needs focus'::<doc>");
    docRow.click();
    render(panel.render(context), container);
    const detail = container.querySelector<HTMLElement>(".opense-detail");
    if (detail === null) throw new Error("Expected the doc detail pane");
    expect(detail.querySelector("h3")?.textContent).toBe("Tracker::'needs focus'::<doc>");
    expect(detail.textContent).toContain("must focus");
    expect(detail.textContent).toContain("Tracker / needs focus");

    render(null, container);
  });

  it("shows the empty workspace state when discovery finds no .sysml files", async () => {
    const files = createFakeFiles({
      trees: {
        "": tree([fileEntry("readme.md", "readme.md"), dirEntry("docs", "docs")]),
        "docs": tree([fileEntry("guide.txt", "docs/guide.txt")]),
      },
    });
    const panel = requiredPanel(createOpenseBrowserContributions("opense", html, svg));
    const context = panelContext(files);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settle();
    render(panel.render(context), container);

    expect(container.querySelector(".opense-empty")?.textContent).toContain("no parseable `.sysml` files found in this workspace");
    expect(container.querySelector(".opense-outline")).toBeNull();
    expect(container.querySelector(".opense-kinds")).toBeNull();
    expect([...container.querySelectorAll(".opense-diagnostic")]).toHaveLength(0);

    render(null, container);
  });

  it("surfaces the loading state while a parse job is in flight, then renders the report", async () => {
    let resolveRead: ((value: FileContentResponse) => void) | undefined;
    const files = createFakeFiles({
      trees: {
        "": tree([fileEntry("model.sysml", "model.sysml")]),
      },
    });
    files.readFile.mockImplementationOnce(
      () => new Promise<FileContentResponse>((resolve) => { resolveRead = resolve; }),
    );
    const panel = requiredPanel(createOpenseBrowserContributions("opense", html, svg));
    const context = panelContext(files);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settle();
    render(panel.render(context), container);

    // The read is still pending: loading state with the Parse button disabled.
    expect(container.textContent).toContain("Parsing workspace…");
    expect(button(container, "Parse").disabled).toBe(true);
    // No report yet → no summary badge either.
    expect(container.querySelector(".opense-status")).toBeNull();

    resolveRead?.(text("package Lonely;"));
    await settle();
    render(panel.render(context), container);

    expect(container.textContent).not.toContain("Parsing workspace…");
    expect(button(container, "Lonely")).toBeDefined();
    expect(button(container, "Parse").disabled).toBe(false);
    // A clean parse flips the summary badge (report.ok, plan §3.4) to "ok".
    expect(container.querySelector(".opense-status.ok")?.textContent).toBe("ok");

    render(null, container);
  });

  it("keeps one report per workspace in the LRU and reuses it on panel switches", async () => {
    const alphaFiles = createFakeFiles({
      trees: { "": tree([fileEntry("a.sysml", "a.sysml")]) },
      reads: { "a.sysml": text("package Alpha;") },
    });
    const betaFiles = createFakeFiles({
      trees: { "": tree([fileEntry("b.sysml", "b.sysml")]) },
      reads: { "b.sysml": text("package Beta;") },
    });
    const panel = requiredPanel(createOpenseBrowserContributions("opense", html, svg));
    const container = document.createElement("div");
    document.body.append(container);

    const alphaContext = panelContext(alphaFiles, openseWorkspace);
    render(panel.render(alphaContext), container);
    await settle();
    render(panel.render(alphaContext), container);
    expect(button(container, "Alpha")).toBeDefined();

    const betaContext = panelContext(betaFiles, { ...openseWorkspace, id: "workspace-2" });
    render(panel.render(betaContext), container);
    await settle();
    render(panel.render(betaContext), container);
    expect(button(container, "Beta")).toBeDefined();
    expect(findButton(container, "Alpha")).toBeUndefined();

    // Switching back to the alpha workspace reuses its cached report; the
    // change-guarded activity element does not re-kick discovery.
    render(panel.render(alphaContext), container);
    await settle();
    expect(button(container, "Alpha")).toBeDefined();
    expect(alphaFiles.listCalls).toHaveLength(1);
    expect(betaFiles.listCalls).toHaveLength(1);

    render(null, container);
  });

  it("marks the report stale while an onInvalidate parse is in flight", async () => {
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("a.sysml", "a.sysml")]) },
      reads: { "a.sysml": text("package Alpha;") },
    });
    const panel = requiredPanel(createOpenseBrowserContributions("opense", html, svg));
    const context = panelContext(files);
    const container = document.createElement("div");
    document.body.append(container);
    render(panel.render(context), container);
    await settle();
    render(panel.render(context), container);
    expect(container.querySelector(".opense-stale")).toBeNull();

    const pending = panel.onInvalidate?.(context);
    render(panel.render(context), container);
    expect(container.querySelector(".opense-stale")?.textContent).toBe("stale");

    await pending;
    render(panel.render(context), container);
    expect(container.querySelector(".opense-stale")).toBeNull();

    render(null, container);
  });
});

function requiredPanel(contributions: ReturnType<typeof createOpenseBrowserContributions>) {
  const panel = contributions.workspacePanels?.[0];
  if (panel === undefined) throw new Error("Expected OpenSE workspace panel");
  return panel;
}

function panelContext(
  fake: FakeWorkspaceFiles,
  workspace = openseWorkspace,
  machineId = "local",
  insertText: (text: string) => void = () => undefined,
): WorkspacePanelContext {
  const files = fake.files;
  const noop = () => undefined;
  return {
    machine: { id: machineId, name: machineId, kind: "local" },
    workspace,
    state: { selectedWorkspace: workspace, workspaceTool: "opense:workspace.opense", mainView: "opense:workspace.opense" },
    files,
    host: { requestRender: noop },
    prompt: { insertText, getText: () => "", getSelection: () => null },
    terminal: { open: noop, runCommand: () => Promise.reject(new Error("not implemented")) },
  };
}

function runtimeContext(patch: Partial<PluginRuntimeContext> = {}): PluginRuntimeContext {
  const noop = () => undefined;
  return {
    state: { selectedWorkspace: openseWorkspace, workspaceTool: "opense:workspace.opense", mainView: "opense:workspace.opense" },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    openActionPalette: noop,
    focusPrompt: noop,
    addProject: noop,
    configureAuth: noop,
    logoutAuth: noop,
    openThemePicker: noop,
    selectMainView: noop,
    selectWorkspaceTool: noop,
    openTerminal: noop,
    refreshFiles: noop,
    refreshWorkspacePanels: noop,
    refreshAppData: noop,
    reloadPage: noop,
    startSession: noop,
    archiveSession: noop,
    stopActiveWork: noop,
    ...patch,
  };
}

function button(container: ParentNode, text: string): HTMLButtonElement {
  const found = findButton(container, text);
  if (found === undefined) throw new Error(`Expected button ${text}; rendered text: ${container.textContent ?? ""}`);
  return found;
}

function findButton(container: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((candidate) => candidate.textContent.trim().includes(text));
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}