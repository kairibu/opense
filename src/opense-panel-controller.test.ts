// @vitest-environment node
//
// Controller unit tests (plan §5): DOM-free. Drive `OpenseWorkspaceController`
// through a fake host (`{isConnected}` — the minimal `OpenseWorkspaceHost`
// surface for the late-async-write guard, no addController/removeController
// needed since the panel drives the lifecycle directly) with the real parse
// job over the fake files adapter for the discovery→loadModel→index→report
// chain, and injected fake jobs for rejection and deferred-control cases.
// Render notifications are asserted on the context host's `requestRender` —
// the controller routes updates through the CURRENT context handle, so the
// spy simply wraps the same `WorkspacePanelHost` it would call in the panel.
// The element/DOM wiring is covered by opense-panel.test.ts; these cover the
// controller's state logic with no DOM at all.

import { describe, expect, it, vi, type Mock } from "vitest";
import type { FileContentResponse, Workspace, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { createModelIndex, loadModel } from "./vendor/sysml-parser.bundle.js";
import { OpenseWorkspaceController, type OpenseParseJob, type OpenseWorkspaceHost } from "./opense-panel-controller.js";
import type { OpenseParseResult } from "./opense-panel.js";
import { parseOpenseWorkspace } from "./opense-panel.js";
import { createFakeFiles, fileEntry, text, tree, type FakeWorkspaceFiles } from "./test-support.js";

const openseWorkspace: Workspace = {
  id: "workspace-1",
  projectId: "project-1",
  path: "/repo",
  label: "main",
  isMain: true,
};

/** A genuine vendor parse result over an empty model: real index and real
 *  workspace from `loadModel([])` + `createModelIndex`, so the
 *  `namedOutlineKinds`/`selectionIn` paths that consume the index run against
 *  the real shape instead of a stub that could drift from `ModelIndex`. */
const emptyParseResult: OpenseParseResult = (() => {
  const workspace = loadModel([]);
  return {
    report: { diagnostics: [], outline: [], ok: true, parsedFileCount: 0 },
    index: createModelIndex(workspace),
    workspace,
  };
})();

describe("OpenseWorkspaceController (fake host, no DOM)", () => {
  it("kicks the first parse on hostConnected and idempotently rejoins on later connects", async () => {
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("a.sysml", "a.sysml")]) },
      reads: { "a.sysml": text("package Alpha;") },
    });
    const { context, requestRender } = panelContext(files);
    const { host } = fakeHost();
    const controller = new OpenseWorkspaceController(host, context, parseOpenseWorkspace);

    controller.hostConnected();
    // The parse begins synchronously: loading is up and the host is notified
    // before any await.
    expect(controller.loading).toBe(true);
    expect(host.isConnected).toBe(true);
    expect(requestRender).toHaveBeenCalled();

    await settle();
    expect(controller.loading).toBe(false);
    expect(controller.stale).toBe(false);
    expect(controller.error).toBeUndefined();
    expect(controller.result?.report.outline.map((row) => row.name)).toContain("Alpha");
    expect(files.listCalls).toEqual([""]);

    // Re-connect (same workspace, e.g. panel re-render): the cached report is
    // reused and discovery does not re-run.
    requestRender.mockClear();
    controller.hostConnected();
    expect(files.listCalls).toHaveLength(1);
    expect(controller.result?.report.outline.map((row) => row.name)).toContain("Alpha");
  });

  it("surfaces loading and reuses one in-flight job for re-entrant parses", async () => {
    let resolveRead: ((value: FileContentResponse) => void) | undefined;
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("a.sysml", "a.sysml")]) },
    });
    files.readFile.mockImplementationOnce(() => new Promise<FileContentResponse>((resolve) => { resolveRead = resolve; }));
    const { context } = panelContext(files);
    const { host } = fakeHost();
    const controller = new OpenseWorkspaceController(host, context, parseOpenseWorkspace);

    controller.hostConnected();
    expect(controller.loading).toBe(true);

    // Parse-button spam / invalidate during a run / switch-back all join the
    // running job instead of stacking new ones.
    const first = controller.parse();
    const second = controller.parse();
    expect(second).toBe(first);
    controller.hostConnected();
    // Let the discovery walk reach the (deferred) read before resolving it.
    await settle();
    expect(files.listCalls).toEqual([""]);

    resolveRead?.(text("package Alpha;"));
    await first;
    expect(controller.loading).toBe(false);
    expect(controller.result?.report.ok).toBe(true);
    expect(files.listCalls).toHaveLength(1);
  });

  it("marks the report stale during an invalidate parse and keeps the old report until it lands", async () => {
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("a.sysml", "a.sysml")]) },
      reads: { "a.sysml": text("package Alpha;") },
    });
    const { context, requestRender } = panelContext(files);
    const { host } = fakeHost();
    const controller = new OpenseWorkspaceController(host, context, parseOpenseWorkspace);
    controller.hostConnected();
    await settle();
    const before = controller.result;
    if (before === undefined) throw new Error("Expected the first parse to land");
    expect(controller.stale).toBe(false);

    let resolveRead: ((value: FileContentResponse) => void) | undefined;
    files.readFile.mockImplementationOnce(() => new Promise<FileContentResponse>((resolve) => { resolveRead = resolve; }));
    requestRender.mockClear();
    const pending = controller.invalidate();

    expect(controller.stale).toBe(true);
    expect(controller.loading).toBe(true);
    // The old report stays rendered while the fresh parse is in flight.
    expect(controller.result).toBe(before);
    expect(requestRender).toHaveBeenCalled();

    // Let the discovery walk reach the (deferred) read before resolving it.
    await settle();

    resolveRead?.(text("package Beta;"));
    await pending;
    expect(controller.stale).toBe(false);
    expect(controller.loading).toBe(false);
    expect(controller.result?.report.outline.map((row) => row.name)).toContain("Beta");
  });

  it("clears a filtered-out selection and drops a vanished kind filter / selection on re-parse", async () => {
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("model.sysml", "model.sysml")]) },
      reads: {
        "model.sysml": text("package Tracker {\n  package Parts { part lens : LensCell; }\n}"),
      },
    });
    const { context } = panelContext(files);
    const { host } = fakeHost();
    const controller = new OpenseWorkspaceController(host, context, parseOpenseWorkspace);
    controller.hostConnected();
    await settle();

    const trackerId = controller.result?.report.outline.find((row) => row.name === "Tracker")?.id;
    const lensId = controller.result?.report.outline.find((row) => row.name === "lens")?.id;
    if (trackerId === undefined || lensId === undefined) throw new Error("Expected Tracker and lens outline rows");

    controller.selectRow(trackerId);
    expect(controller.selectedId).toBe(trackerId);

    // Filtering to parts hides the selected package; the dangling selection
    // is dropped (a filtered-out detail pane would dangle).
    controller.setKindFilter("part");
    expect(controller.kindFilter).toBe("part");
    expect(controller.selectedId).toBeUndefined();

    controller.selectRow(lensId);
    expect(controller.selectedId).toBe(lensId);

    // Switching the filter back to "all kinds" keeps the (now visible) selection.
    controller.setKindFilter(undefined);
    expect(controller.selectedId).toBe(lensId);

    // A re-parse whose model lost the part kind drops the filter...
    const betaFiles = createFakeFiles({
      trees: { "": tree([fileEntry("b.sysml", "b.sysml")]) },
      reads: { "b.sysml": text("package Beta;") },
    });
    controller.setKindFilter("part");
    controller.context = panelContext(betaFiles).context;
    await controller.parse();
    expect(controller.kindFilter).toBeUndefined();

    // ...and a re-parse whose model dropped the selected element clears the
    // selection.
    const gammaFiles = createFakeFiles({
      trees: { "": tree([fileEntry("c.sysml", "c.sysml")]) },
      reads: { "c.sysml": text("package Gamma;") },
    });
    controller.context = panelContext(gammaFiles).context;
    controller.selectRow(lensId);
    await controller.parse();
    expect(controller.selectedId).toBeUndefined();
    expect(controller.result?.report.outline.map((row) => row.name)).toContain("Gamma");
  });

  it("drops late async writes after hostDisconnected and after the eviction release", async () => {
    const resolvers: Array<(result: OpenseParseResult) => void> = [];
    const job: OpenseParseJob = () => new Promise((resolve) => { resolvers.push(resolve); });
    const { context, requestRender } = panelContext(createFakeFiles());
    const { host } = fakeHost();
    const controller = new OpenseWorkspaceController(host, context, job);

    controller.hostConnected();
    controller.hostDisconnected();
    requestRender.mockClear();
    resolvers[0]?.(emptyParseResult);
    await settle();
    expect(controller.result).toBeUndefined();
    expect(controller.loading).toBe(false);
    // The host is no longer connected: no state mutation reached it.
    expect(requestRender).not.toHaveBeenCalled();

    // The LRU eviction release drops writes the same way — even while the
    // element itself stayed connected.
    controller.hostConnected();
    controller.release();
    requestRender.mockClear();
    resolvers[1]?.(emptyParseResult);
    await settle();
    expect(controller.result).toBeUndefined();
    expect(controller.loading).toBe(false);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("surfaces a rejected parse as the formatted error message", async () => {
    const { context } = panelContext(createFakeFiles());
    const { host } = fakeHost();
    const controller = new OpenseWorkspaceController(host, context, async () => {
      throw new Error("Parser crashed");
    });
    controller.hostConnected();
    await settle();
    expect(controller.error).toBe("Parser crashed");
    expect(controller.loading).toBe(false);
    expect(controller.result).toBeUndefined();
  });

  it("skips requestRender while disconnected and restores it on reconnect", async () => {
    const { context, requestRender } = panelContext(createFakeFiles());
    const { host } = fakeHost();
    const controller = new OpenseWorkspaceController(host, context, parseOpenseWorkspace);
    controller.hostConnected();
    await settle();
    requestRender.mockClear();

    controller.selectRow("row-1");
    expect(requestRender).toHaveBeenCalledTimes(1);

    controller.hostDisconnected();
    controller.selectRow("row-2");
    expect(requestRender).toHaveBeenCalledTimes(1);

    // Reconnecting restores updates (the cached report is reused, no re-parse).
    controller.hostConnected();
    controller.selectRow("row-3");
    expect(requestRender).toHaveBeenCalledTimes(2);
  });
});

function fakeHost(): { host: OpenseWorkspaceHost } {
  return { host: { isConnected: false } };
}

/** Build one panel context wrapping the fake files adapter plus a `requestRender`
 *  spy — the controller's render path fires this (via the context host). */
function panelContext(fake: FakeWorkspaceFiles): { context: WorkspacePanelContext; requestRender: Mock } {
  const requestRender = vi.fn();
  const context: WorkspacePanelContext = {
    machine: { id: "local", name: "local", kind: "local" },
    workspace: openseWorkspace,
    state: { selectedWorkspace: openseWorkspace, workspaceTool: "opense:workspace.opense", mainView: "opense:workspace.opense" },
    files: fake.files,
    host: { requestRender },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
    terminal: { open: noop, runCommand: () => Promise.reject(new Error("not implemented")) },
  };
  return { context, requestRender };
}

const noop = () => undefined;

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}