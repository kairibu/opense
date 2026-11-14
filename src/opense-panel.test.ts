// @vitest-environment happy-dom
//
// Layer 4 (component boundary): OpenSE workspace panel. Real render +
// interaction through the custom-element/property contract, exactly the git
// panel harness shape (pi-web-plugins/git/pi-web-plugin.test.ts): the
// activity element is connected via the body element's shadow root, so
// controller hostConnected drives the first parse; host.requestRender is a
// noop, so tests re-render manually after settling. The parse job runs
// against a fake files adapter, so the whole discovery→loadModel→index→report
// chain is proven in one render test with no backend anywhere.
//
// Phase 3: the panel UI lives in shadow roots now (plan §3.4), so every
// content assertion resolves the rendered elements through
// `pi-web-opense-panel-body`/`pi-web-opense-panel-activity` shadowRoot (the
// light DOM only carries the body element itself). Lit's async-batched
// reactive updates mean every mutation is followed by awaiting the elements'
// updateComplete before asserting (plan §5) — `renderPanel` below does that
// for the host-render contract the panel drive shares.

import { html, render, svg } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FileContentResponse,
  PluginContributionsV5,
  PluginRuntimeContext,
  PluginRuntimeContextV5,
  Workspace,
  WorkspacePanelContextV5,
} from "@jmfederico/pi-web/plugin-api";
import { createOpenseBrowserContributions } from "./opense-panel.js";
import type { OpenseActionPaletteElement } from "./opense-panel-palette.js";
import {
  activityElementTag,
  bodyElementTag,
  type OpensePanelActivityElement,
  type OpensePanelBodyElement,
} from "./opense-panel-elements.js";
import {
  createFakeFiles,
  createFakeNavigation,
  createFakeCatalog,
  createPanelContext,
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
  // C1: never let a preference test leak its localStorage key into the
  // next test (the file's own tests are preference-independent otherwise).
  localStorage.removeItem("opense.claimSysmlLinks");
});

describe("bundled OpenSE browser plugin", () => {
  it("contributes an always-visible panel and three unconditional actions", async () => {
    const { contributions } = createOpenseBrowserContributions("opense", html, svg);
    const panel = requiredPanel({ contributions });
    const context = panelContext(createFakeFiles({ trees: {} }));

    expect(panel.id).toBe("workspace.opense");
    expect(panel.title).toBe("OpenSE");
    expect(panel.order).toBe(7);
    expect(panel.icon).toBeDefined();
    // Browser-only: no provider ownership, so visibility never gates.
    expect(panel.visible?.(context)).toBe(true);
    expect(panel.visible?.(panelContext(createFakeFiles({ trees: {} }), { ...openseWorkspace, id: "workspace-2" }))).toBe(true);
    expect(panel.invalidationResources).toEqual(["workspace.files"]);
    expect(typeof panel.onInvalidate).toBe("function");

    const actions = contributions.actions ?? [];
    expect(actions.map(({ id }) => id)).toEqual(["view.opense", "workspace.refresh-opense", "opense.claim-sysml-links"]);
    const goToOpense = actions[0];
    const refresh = actions[1];
    expect(goToOpense?.shortcut).toBe("mod+6");
    expect(refresh?.shortcut).toBe("mod+shift+m");
    // All three actions are enabled unconditionally (no `enabled` gate at all).
    expect(goToOpense?.enabled).toBeUndefined();
    expect(refresh?.enabled).toBeUndefined();

    const selectWorkspaceTool = vi.fn<PluginRuntimeContext["selectWorkspaceTool"]>();
    const refreshWorkspacePanels = vi.fn<PluginRuntimeContext["refreshWorkspacePanels"]>(() => panel.onInvalidate?.(context));
    const runtime = runtimeContext({ selectWorkspaceTool, refreshWorkspacePanels });
    await goToOpense?.run(runtime);
    expect(selectWorkspaceTool).toHaveBeenCalledWith("opense:workspace.opense");

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
    await renderPanel(panel, context, container);
    // The parse landed during the previous settle; re-render mirrors the new
    // controller state into the elements (host.requestRender is a noop here).
    await renderPanel(panel, context, container);
    const root = bodyShadow(container);

    // Toolbar with the Parse (not "Check"/"Validate") button.
    const parseButton = button(root, "Parse");
    expect(parseButton.disabled).toBe(false);

    // Summary badge (report.ok, plan §3.4): the discovery read failure and
    // the parser lexer error make the combined report fail → "issues". The
    // strip lives in the activity element's shadow root.
    expect(activityShadow(container)?.querySelector(".opense-status.issues")?.textContent).toBe("issues");

    // Discovery diagnostic (read failure) first, then the parser's own
    // pre-formatted lexer diagnostic with its path and line:col message.
    const diagnostics = [...root.querySelectorAll(".opense-diagnostic")].map((entry) => entry.textContent);
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
    expect(button(root, "Tracker").textContent).toContain("package");
    const partsRow = button(root, "Parts");
    expect(partsRow.getAttribute("style")).toContain("--depth:1");
    expect(button(root, "lens").getAttribute("style")).toContain("--depth:2");
    expect(root.querySelector(".opense-outline")).not.toBeNull();

    // Vertical layout split: the element list pane must precede the details
    // pane in DOM order (regression guard for the horizontal-vs-vertical axis
    // swap, mirroring the syside panel test pattern).
    const list = root.querySelector(".opense-left");
    const details = root.querySelector(".opense-right");
    expect(list && details && (list.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();

    // Element-detail pane after selecting the lens part.
    button(root, "lens").click();
    await renderPanel(panel, context, container);
    const detail = root.querySelector<HTMLElement>(".opense-detail");
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
    const right = root.querySelector<HTMLElement>(".opense-right");
    if (right === null) throw new Error("Expected the details pane");
    const palette = right.querySelector<OpenseActionPaletteElement>("pi-web-opense-action-palette");
    if (palette === null) throw new Error("Expected the action palette below the element details");
    // Pinned-footer layout: the detail section precedes the palette, and the
    // palette is a flex item at the bottom edge of the details pane.
    expect(detail.compareDocumentPosition(palette) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(palette.subject).toBe("Tracker::Parts::lens");
    expect(palette.filepath).toBe("model/good.sysml");
    // The palette is a LitElement: its first render happens in a microtask
    // after connect, so the shadow DOM buttons exist only after updateComplete
    // (renderPanel awaited it, but they are still fresh commits).
    await palette.updateComplete;
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
    await renderPanel(panel, context, container);
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
    await renderPanel(panel, context, container);
    await renderPanel(panel, context, container);
    const root = bodyShadow(container);

    const kindsRow = root.querySelector<HTMLElement>(".opense-kinds");
    if (kindsRow === null) throw new Error("Expected the kind filter row");
    expect(kindsRow.textContent).toContain("All (2)");
    expect(kindsRow.textContent).toContain("package");
    expect(kindsRow.textContent).toContain("part");

    button(root, "Tracker").click();
    await renderPanel(panel, context, container);
    expect(root.querySelector(".opense-detail")?.textContent).toContain("Tracker");

    button(root, "part").click();
    await renderPanel(panel, context, container);
    // Package rows are filtered out; the selected package cleared accordingly.
    expect(findButton(root, "Tracker")).toBeUndefined();
    expect(findButton(root, "Parts")).toBeUndefined();
    expect(button(root, "lens")).toBeDefined();
    expect(root.textContent).toContain("Select an element in the outline to inspect its details.");

    button(root, "lens").click();
    await renderPanel(panel, context, container);
    expect(root.querySelector(".opense-detail")?.textContent).toContain("Tracker::Parts::lens");

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
    await renderPanel(panel, context, container);
    await renderPanel(panel, context, container);
    const root = bodyShadow(container);

    // The outline lists named rows only: no italic "doc" row for the
    // requirement's unnamed documentation.
    expect(button(root, "Tracker")).toBeDefined();
    expect(button(root, "needs focus")).toBeDefined();
    expect(button(root, "lens")).toBeDefined();
    expect(findButton(root, "doc")).toBeUndefined();

    // The requirement's detail pane surfaces its owned doc with a preview.
    button(root, "needs focus").click();
    await renderPanel(panel, context, container);
    const owned = root.querySelector(".opense-owned");
    if (owned === null) throw new Error("Expected the owned-elements section");
    expect(owned.textContent).toContain("doc");
    expect(owned.textContent).toContain("must focus");

    // Clicking the owned doc row navigates to the doc's own details (by id),
    // where its full text renders as a curated field.
    const docRow = owned.querySelector<HTMLButtonElement>(".opense-row.owned");
    if (docRow === null) throw new Error("Expected an owned row");
    expect(docRow.dataset["id"]).toBe("Tracker::'needs focus'::<doc>");
    docRow.click();
    await renderPanel(panel, context, container);
    const detail = root.querySelector<HTMLElement>(".opense-detail");
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
    await renderPanel(panel, context, container);
    await renderPanel(panel, context, container);
    const root = bodyShadow(container);

    expect(root.querySelector(".opense-empty")?.textContent).toContain("no parseable `.sysml` files found in this workspace");
    expect(root.querySelector(".opense-outline")).toBeNull();
    expect(root.querySelector(".opense-kinds")).toBeNull();
    expect([...root.querySelectorAll(".opense-diagnostic")]).toHaveLength(0);

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
    await renderPanel(panel, context, container);
    await renderPanel(panel, context, container);
    const root = bodyShadow(container);

    // The read is still pending: loading state with the Parse button disabled
    // and the loading empty-state text in the body region.
    expect(root.textContent).toContain("Parsing workspace…");
    expect(button(root, "Parse").disabled).toBe(true);
    // No report yet → no summary badge either (empty strip).
    expect(root.querySelector(".opense-status")).toBeNull();

    resolveRead?.(text("package Lonely;"));
    await settle();
    await renderPanel(panel, context, container);

    expect(root.textContent).not.toContain("Parsing workspace…");
    expect(button(root, "Lonely")).toBeDefined();
    expect(button(root, "Parse").disabled).toBe(false);
    // A clean parse flips the summary badge (report.ok, plan §3.4) to "ok".
    expect(activityShadow(container)?.querySelector(".opense-status.ok")?.textContent).toBe("ok");

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
    await renderPanel(panel, alphaContext, container);
    await renderPanel(panel, alphaContext, container);
    expect(button(bodyShadow(container), "Alpha")).toBeDefined();

    const betaContext = panelContext(betaFiles, { ...openseWorkspace, id: "workspace-2" });
    await renderPanel(panel, betaContext, container);
    await renderPanel(panel, betaContext, container);
    expect(button(bodyShadow(container), "Beta")).toBeDefined();
    expect(findButton(bodyShadow(container), "Alpha")).toBeUndefined();

    // Switching back to the alpha workspace reuses its cached report; the
    // activity element's controller swap does not re-kick discovery.
    await renderPanel(panel, alphaContext, container);
    expect(button(bodyShadow(container), "Alpha")).toBeDefined();
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
    await renderPanel(panel, context, container);
    await renderPanel(panel, context, container);
    expect(activityShadow(container)?.querySelector(".opense-stale")).toBeNull();

    const pending = panel.onInvalidate?.(context);
    await renderPanel(panel, context, container);
    expect(activityShadow(container)?.querySelector(".opense-stale")?.textContent).toBe("stale");

    await pending;
    await renderPanel(panel, context, container);
    expect(activityShadow(container)?.querySelector(".opense-stale")).toBeNull();

    render(null, container);
  });

  // W1: manual refresh arrives without an invalidation argument and must keep
  // the old immediate-parse semantics; a host-supplied manual invalidation
  // (from `invalidateWorkspaceResources`) does the same.
  it("keeps the immediate onInvalidate parse with and without an invalidation argument", async () => {
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("a.sysml", "a.sysml")]) },
      reads: { "a.sysml": text("package Alpha;") },
    });
    const panel = requiredPanel(createOpenseBrowserContributions("opense", html, svg));
    const context = panelContext(files);

    // Backward compat: no invalidation argument (the manual Refresh action).
    await panel.onInvalidate?.(context);
    expect(files.listCalls).toHaveLength(1);

    // Explicit host-supplied manual invalidation.
    await panel.onInvalidate?.(context, { reason: "manual", resources: ["workspace.files"] });
    expect(files.listCalls).toHaveLength(2);
  });

  // W2: `dispose` releases the whole registry, so a recreate starts from a
  // cold cache instead of reusing the released workspace report.
  it("releases every cached workspace on dispose, so a re-render re-parses", async () => {
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("a.sysml", "a.sysml")]) },
      reads: { "a.sysml": text("package Alpha;") },
    });
    const { contributions, dispose } = createOpenseBrowserContributions("opense", html, svg);
    const panel = requiredPanel({ contributions });
    const context = panelContext(files);
    const container = document.createElement("div");
    document.body.append(container);

    await renderPanel(panel, context, container);
    expect(files.listCalls).toHaveLength(1);
    // Re-rendering without dispose reuses the cached report.
    await renderPanel(panel, context, container);
    expect(files.listCalls).toHaveLength(1);

    dispose();
    await renderPanel(panel, context, container);
    await renderPanel(panel, context, container);
    expect(files.listCalls).toHaveLength(2);

    render(null, container);
  });

  // W4a: selecting a row mirrors it into the contribution query so the URL
  // round-trips (`opense--element=<id>`).
  it("mirrors the outline selection into the contribution query", async () => {
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("model.sysml", "model.sysml")]) },
      reads: { "model.sysml": text("package Tracker;") },
    });
    const panel = requiredPanel(createOpenseBrowserContributions("opense", html, svg));
    const { navigation, set } = createFakeNavigation();
    const { context } = createPanelContext({ files: files.files, navigation });
    const container = document.createElement("div");
    document.body.append(container);
    await renderPanel(panel, context, container);
    await renderPanel(panel, context, container);

    button(bodyShadow(container), "Tracker").click();
    await renderPanel(panel, context, container);
    expect(set).toHaveBeenCalledWith("element", "Tracker");
    expect(navigation.query["element"]).toBe("Tracker");

    render(null, container);
  });

  // W4a: a fresh tab whose URL carries the element query restores that
  // element in the detail section once the parse lands.
  it("restores a deep-linked element selection from the navigation query", async () => {
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("model.sysml", "model.sysml")]) },
      reads: { "model.sysml": text("package Tracker {\n  part lens : LensCell;\n}") },
    });
    const panel = requiredPanel(createOpenseBrowserContributions("opense", html, svg));
    const { navigation } = createFakeNavigation({ query: { element: "Tracker::lens" } });
    const { context } = createPanelContext({ files: files.files, navigation });
    const container = document.createElement("div");
    document.body.append(container);
    await renderPanel(panel, context, container);
    await renderPanel(panel, context, container);

    const detail = bodyShadow(container).querySelector<HTMLElement>(".opense-detail");
    expect(detail?.textContent).toContain("lens");

    render(null, container);
  });

  // C1 (D1): `.sysml` file links from the chat transcript open OpenSE at
  // file level — `fileOpenQuery` claims them while the per-browser
  // preference is on (default), and hands everything else back to Files.
  it("claims .sysml file links through fileOpenQuery, gated on the preference", () => {
    const panel = requiredPanel(createOpenseBrowserContributions("opense", html, svg));
    const context = panelContext(createFakeFiles({ trees: {} }));
    const fileOpenQuery = panel.fileOpenQuery;
    if (fileOpenQuery === undefined) throw new Error("Expected the panel's fileOpenQuery");

    expect(fileOpenQuery(context, "models/a.sysml")).toEqual({ file: "models/a.sysml" });
    // Case-insensitive extension check; the claimed path is verbatim.
    expect(fileOpenQuery(context, "models/Wheel.SYSML")).toEqual({ file: "models/Wheel.SYSML" });
    // Non-`.sysml` paths return undefined so the Files panel (order 10)
    // answers as before.
    expect(fileOpenQuery(context, "readme.md")).toBeUndefined();
    expect(fileOpenQuery(context, "notes.txt")).toBeUndefined();

    try {
      localStorage.setItem("opense.claimSysmlLinks", "0");
      // Preference off → OpenSE claims nothing; Files answers .sysml again.
      expect(fileOpenQuery(context, "models/a.sysml")).toBeUndefined();
    } finally {
      localStorage.removeItem("opense.claimSysmlLinks");
    }
  });

  // C1: the third action is the per-browser preference toggle — no shortcut,
  // Workspace group, a title GETTER reflecting the current state, and a run
  // that flips the stored preference (read synchronously per click, so no
  // reload is needed anywhere).
  it("toggles the .sysml link claim through the palette action", async () => {
    const { contributions } = createOpenseBrowserContributions("opense", html, svg);
    const action = (contributions.actions ?? []).find(({ id }) => id === "opense.claim-sysml-links");
    if (action === undefined) throw new Error("Expected the claim-sysml-links action");
    expect(action.group).toBe("Workspace");
    expect(action.shortcut).toBeUndefined();

    try {
      localStorage.removeItem("opense.claimSysmlLinks");
      // Title reflects the CURRENT state: claiming is on (default), so the
      // action offers to hand the links back to Files.
      expect(action.title).toBe("Open .sysml links in Files");
      await action.run(runtimeContext());
      expect(localStorage.getItem("opense.claimSysmlLinks")).toBe("0");
      // Now claiming is off, so the action offers to claim for OpenSE.
      expect(action.title).toBe("Open .sysml links in OpenSE");
      await action.run(runtimeContext());
      expect(localStorage.getItem("opense.claimSysmlLinks")).toBe("1");
      expect(action.title).toBe("Open .sysml links in Files");
    } finally {
      localStorage.removeItem("opense.claimSysmlLinks");
    }
  });

  // C3: a deep-linked element that resolves to nothing surfaces a dismissible
  // notice above the outline instead of failing silently.
  it("renders a dismissible notice for an unresolvable deep-linked element", async () => {
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("model.sysml", "model.sysml")]) },
      reads: { "model.sysml": text("package Tracker {\n  part lens : LensCell;\n}") },
    });
    const panel = requiredPanel(createOpenseBrowserContributions("opense", html, svg));
    const { navigation } = createFakeNavigation({ query: { element: "Tracker::missing" } });
    const { context } = createPanelContext({ files: files.files, navigation });
    const container = document.createElement("div");
    document.body.append(container);
    await renderPanel(panel, context, container);
    await renderPanel(panel, context, container);
    const root = bodyShadow(container);

    const notice = root.querySelector<HTMLElement>(".opense-selection-notice");
    if (notice === null) throw new Error("Expected the selection notice");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain("'Tracker::missing' was not found in the current model");
    // Above the outline: the notice precedes it in DOM order (between the
    // kind filter and the outline in .opense-left).
    const outline = root.querySelector(".opense-outline");
    if (outline === null) throw new Error("Expected the outline");
    expect(notice.compareDocumentPosition(outline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The miss selected nothing: no selected row, empty detail pane.
    expect(root.querySelector(".opense-row.is-selected")).toBeNull();
    expect(root.textContent).toContain("Select an element in the outline to inspect its details.");

    // Dismiss clears the notice (the controller's dismiss method) without
    // touching the (empty) selection.
    button(root, "Dismiss").click();
    await renderPanel(panel, context, container);
    expect(root.querySelector(".opense-selection-notice")).toBeNull();

    render(null, container);
  });
});

function requiredPanel(result: { contributions: PluginContributionsV5 }) {
  const panel = result.contributions.workspacePanels?.[0];
  if (panel === undefined) throw new Error("Expected OpenSE workspace panel");
  return panel;
}

/** Host-contract render step: render the panel template and let every
 *  involved element flush its Lit updates (plan §5 — `updateComplete`).
 *  `host.requestRender` is a noop in tests, so each controller mutation is
 *  followed by another render step that re-mirrors the controller state. */
async function renderPanel(
  panel: ReturnType<typeof requiredPanel>,
  context: WorkspacePanelContextV5,
  container: HTMLElement,
): Promise<void> {
  render(panel.render(context), container);
  await panelSettled(container);
}

/** Let microtasks flush (parse kicks happen inside the body element's first
 *  shadow render) and await the body/activity/palette updateCompletes. */
async function panelSettled(container: ParentNode): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  const body = container.querySelector(bodyElementTag) as OpensePanelBodyElement | null;
  await body?.updateComplete;
  const activity = body?.shadowRoot?.querySelector(activityElementTag) as OpensePanelActivityElement | null;
  await activity?.updateComplete;
  const palette = body?.shadowRoot?.querySelector("pi-web-opense-action-palette") as OpenseActionPaletteElement | null;
  await palette?.updateComplete;
  // Shadow updates scheduled by the commits above flush here.
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function bodyShadow(container: ParentNode): ShadowRoot {
  const body = container.querySelector(bodyElementTag);
  if (body === null) throw new Error("Expected the OpenSE panel body element");
  if (body.shadowRoot === null) throw new Error("Expected the panel body shadow root");
  return body.shadowRoot;
}

function activityShadow(container: ParentNode): ShadowRoot | null {
  const body = container.querySelector(bodyElementTag) as OpensePanelBodyElement | null;
  return body?.shadowRoot?.querySelector(activityElementTag)?.shadowRoot ?? null;
}

function panelContext(
  fake: FakeWorkspaceFiles,
  workspace = openseWorkspace,
  machineId = "local",
  insertText: (text: string) => void = () => undefined,
): WorkspacePanelContextV5 {
  // Plan v4 §0.2: the shared builder in test-support.ts owns the context
  // shape; this adapter keeps the terse positional call sites in this file.
  return createPanelContext({ files: fake.files, workspace, machineId, insertText }).context;
}

function runtimeContext(patch: Partial<PluginRuntimeContextV5> = {}): PluginRuntimeContextV5 {
  const noop = () => undefined;
  return {
    state: { selectedWorkspace: openseWorkspace, workspaceTool: "opense:workspace.opense", mainView: "workspace" },
    catalog: createFakeCatalog(),
    navigate: () => Promise.resolve(),
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