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

import { describe, expect, it, vi } from "vitest";
import type { FileContentResponse, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { createModelIndex, loadModel } from "./vendor/sysml-parser.bundle.js";
import {
  INVALIDATION_DEBOUNCE_MS,
  OpenseWorkspaceController,
  type OpenseParseJob,
} from "./opense-panel-controller.js";
import type { OpenseParseResult } from "./opense-panel.js";
import { parseOpenseWorkspace } from "./opense-panel.js";
import {
  createFakeCapabilityV1Files,
  createFakeFiles,
  createFakeHost,
  createFakeNavigation,
  createPanelContext,
  fileEntry,
  text,
  tree,
  type FakeWorkspaceFiles,
} from "./test-support.js";

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

  // --- W1: automatic invalidation with a reason-aware parse gate ----------

  it("coalesces a mutation/agent-activity burst into one parse and sets stale immediately", async () => {
    vi.useFakeTimers();
    try {
      const files = createFakeFiles({
        trees: { "": tree([fileEntry("a.sysml", "a.sysml")]) },
        reads: { "a.sysml": text("package Alpha;") },
      });
      const { context } = panelContext(files);
      const { host } = fakeHost();
      const controller = new OpenseWorkspaceController(host, context, parseOpenseWorkspace);
      controller.hostConnected();
      await settle();
      expect(files.listCalls).toHaveLength(1);
      expect(controller.stale).toBe(false);

      const first = controller.invalidate({ reason: "mutation", resources: ["workspace.files"] });
      // stale is synchronous for every reason, before any parse starts.
      expect(controller.stale).toBe(true);
      const second = controller.invalidate({ reason: "mutation", resources: ["workspace.files"] });
      const third = controller.invalidate({ reason: "agent-activity", resources: ["workspace.files"] });
      // stale is synchronous for every reason — agent-activity included.
      expect(controller.stale).toBe(true);
      // The trailing-edge window is still open: nothing parsed yet.
      expect(files.listCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(INVALIDATION_DEBOUNCE_MS - 1);
      expect(files.listCalls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all([first, second, third]);
      // Exactly one parse for the whole burst.
      expect(files.listCalls).toHaveLength(2);
      expect(controller.stale).toBe(false);

      // A later burst after completion parses exactly once more (never per event).
      void controller.invalidate({ reason: "agent-activity", resources: ["workspace.files"] });
      // stale flips synchronously from a clean state for agent-activity too.
      expect(controller.stale).toBe(true);
      void controller.invalidate({ reason: "mutation", resources: ["workspace.files"] });
      await vi.advanceTimersByTimeAsync(INVALIDATION_DEBOUNCE_MS);
      expect(files.listCalls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bypasses the debounce for a manual invalidation and cancels the pending one", async () => {
    vi.useFakeTimers();
    try {
      const files = createFakeFiles({
        trees: { "": tree([fileEntry("a.sysml", "a.sysml")]) },
        reads: { "a.sysml": text("package Alpha;") },
      });
      const { context } = panelContext(files);
      const { host } = fakeHost();
      const controller = new OpenseWorkspaceController(host, context, parseOpenseWorkspace);
      controller.hostConnected();
      await settle();

      const pending = controller.invalidate({ reason: "mutation", resources: ["workspace.files"] });
      const manual = controller.invalidate({ reason: "manual", resources: ["workspace.files"] });
      await manual;
      await pending;
      expect(files.listCalls).toHaveLength(2);
      // The cancelled timer must never fire a second parse.
      await vi.advanceTimersByTimeAsync(INVALIDATION_DEBOUNCE_MS);
      expect(files.listCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses immediately for a legacy invalidate call without an argument", async () => {
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("a.sysml", "a.sysml")]) },
      reads: { "a.sysml": text("package Alpha;") },
    });
    const { context } = panelContext(files);
    const { host } = fakeHost();
    const controller = new OpenseWorkspaceController(host, context, parseOpenseWorkspace);
    controller.hostConnected();
    await settle();

    await controller.invalidate();
    expect(files.listCalls).toHaveLength(2);
  });

  // --- W3: abort-capable file reads --------------------------------------

  it("forwards the parse signal to capability-v1 files and aborts it on release", async () => {
    let resolveRead: ((value: FileContentResponse) => void) | undefined;
    let captured: AbortSignal | undefined;
    const files = createFakeCapabilityV1Files({
      trees: { "": tree([fileEntry("a.sysml", "a.sysml")]) },
    });
    files.readFile.mockImplementationOnce((_path, options) => {
      captured = options?.signal;
      return new Promise<FileContentResponse>((resolve) => { resolveRead = resolve; });
    });
    const { context } = createPanelContext({ files: files.files });
    const { host } = fakeHost();
    const controller = new OpenseWorkspaceController(host, context, parseOpenseWorkspace);
    controller.hostConnected();
    await settle();

    expect(captured).toBeDefined();
    expect(captured?.aborted).toBe(false);

    controller.release();
    expect(captured?.aborted).toBe(true);

    // The aborted run's late resolution must not install a partial result.
    resolveRead?.(text("package Alpha;"));
    await settle();
    expect(controller.result).toBeUndefined();
  });

  it("aborts the in-flight signal on hostDisconnected and restarts a fresh parse on reconnect", async () => {
    let resolveRead: ((value: FileContentResponse) => void) | undefined;
    let captured: AbortSignal | undefined;
    const files = createFakeCapabilityV1Files({
      trees: { "": tree([fileEntry("a.sysml", "a.sysml")]) },
      reads: { "a.sysml": text("package Alpha;") },
    });
    files.readFile.mockImplementationOnce((_path, options) => {
      captured = options?.signal;
      return new Promise<FileContentResponse>((resolve) => { resolveRead = resolve; });
    });
    const { context } = createPanelContext({ files: files.files });
    const { host } = fakeHost();
    const controller = new OpenseWorkspaceController(host, context, parseOpenseWorkspace);
    controller.hostConnected();
    await settle();
    expect(captured?.aborted).toBe(false);

    controller.hostDisconnected();
    expect(captured?.aborted).toBe(true);
    // Reconnecting while the aborted request is still pending does not stack a
    // second job; the aborted run's `finally` restarts it.
    controller.hostConnected();
    expect(files.listCalls).toHaveLength(1);

    resolveRead?.(text("package Alpha;"));
    await settle();
    await settle();
    expect(controller.result?.report.outline.map((row) => row.name)).toContain("Alpha");
  });

  it("restarts a stale parse on reconnect after an aborted run finished while disconnected", async () => {
    let resolveRead: ((value: FileContentResponse) => void) | undefined;
    const files = createFakeCapabilityV1Files({
      trees: { "": tree([fileEntry("a.sysml", "a.sysml")]) },
      reads: { "a.sysml": text("package Alpha;") },
    });
    const { context } = createPanelContext({ files: files.files });
    const { host } = fakeHost();
    const controller = new OpenseWorkspaceController(host, context, parseOpenseWorkspace);
    controller.hostConnected();
    await settle();
    expect(controller.result).toBeDefined();
    expect(controller.stale).toBe(false);

    // Arm a re-parse whose read stays pending, then disconnect and let the
    // aborted run finish entirely while still disconnected: its `finally`
    // cannot restart the parse (`isConnected` is false).
    files.readFile.mockImplementationOnce((_path, options) => {
      expect(options?.signal).toBeDefined();
      return new Promise<FileContentResponse>((resolve) => { resolveRead = resolve; });
    });
    const pending = controller.invalidate({ reason: "manual", resources: ["workspace.files"] });
    expect(controller.stale).toBe(true);
    await settle();
    controller.hostDisconnected();
    resolveRead?.(text("package Alpha;"));
    await pending;
    expect(controller.stale).toBe(true);
    // The aborted run's discovery walk started, but no result was installed.
    expect(files.listCalls).toHaveLength(2);
    expect(controller.result).toBeDefined();

    // With a pre-existing result the old guard would reuse it forever; the
    // stale flag makes reconnect kick the parse the aborted run could not.
    controller.hostConnected();
    expect(controller.loading).toBe(true);
    await settle();
    expect(controller.stale).toBe(false);
    expect(files.listCalls).toHaveLength(3);
  });

  it("drops a pending debounced invalidation on disconnect and re-parses on reconnect", async () => {
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("a.sysml", "a.sysml")]) },
      reads: { "a.sysml": text("package Alpha;") },
    });
    const { context } = panelContext(files);
    const { host } = fakeHost();
    const controller = new OpenseWorkspaceController(host, context, parseOpenseWorkspace);
    controller.hostConnected();
    await settle();
    expect(files.listCalls).toHaveLength(1);

    // Disconnecting drops the armed debounce (no parse into a disconnected
    // panel) and settles its waiters without hanging.
    const pending = controller.invalidate({ reason: "mutation", resources: ["workspace.files"] });
    controller.hostDisconnected();
    await pending;
    expect(files.listCalls).toHaveLength(1);
    expect(controller.stale).toBe(true);

    // Reconnect resumes the parse from the surviving stale flag.
    controller.hostConnected();
    expect(controller.loading).toBe(true);
    await settle();
    expect(controller.stale).toBe(false);
    expect(files.listCalls).toHaveLength(2);
  });

  it("never passes request options to a legacy files host", async () => {
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("a.sysml", "a.sysml")]) },
      reads: { "a.sysml": text("package Alpha;") },
    });
    const { context } = panelContext(files);
    const { host } = fakeHost();
    const controller = new OpenseWorkspaceController(host, context, parseOpenseWorkspace);
    controller.hostConnected();
    await settle();

    expect(files.listFiles.mock.calls[0]).toHaveLength(1);
    expect(files.readFile.mock.calls[0]).toHaveLength(1);
  });

  // --- W4a: selection ⇄ navigation-query deep links ----------------------

  it("writes the selection into the navigation query", async () => {
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("model.sysml", "model.sysml")]) },
      reads: { "model.sysml": text("package Tracker {\n  part lens : LensCell;\n}") },
    });
    const { navigation, set } = createFakeNavigation();
    const { context } = createPanelContext({ files: files.files, navigation });
    const { host } = fakeHost();
    const controller = new OpenseWorkspaceController(host, context, parseOpenseWorkspace);
    controller.hostConnected();
    await settle();

    expect(controller.selectRow("Tracker::lens")).toBe(true);
    expect(controller.selectedId).toBe("Tracker::lens");
    expect(set).toHaveBeenCalledWith("element", "Tracker::lens");
    expect(navigation.query["element"]).toBe("Tracker::lens");
  });

  it("keeps the selection local-only when the navigation write fails", async () => {
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("model.sysml", "model.sysml")]) },
      reads: { "model.sysml": text("package Tracker {\n  part lens : LensCell;\n}") },
    });
    const { navigation, set } = createFakeNavigation({ applied: false });
    const { context } = createPanelContext({ files: files.files, navigation });
    const { host } = fakeHost();
    const controller = new OpenseWorkspaceController(host, context, parseOpenseWorkspace);
    controller.hostConnected();
    await settle();

    const applied = controller.selectRow("Tracker::lens");
    expect(applied).toBe(false);
    expect(controller.selectedId).toBe("Tracker::lens");
    expect(set).toHaveBeenCalledWith("element", "Tracker::lens");
    expect(navigation.query["element"]).toBeUndefined();
  });

  it("selects without crashing when the host has no navigation (legacy)", async () => {
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("model.sysml", "model.sysml")]) },
      reads: { "model.sysml": text("package Tracker {\n  part lens : LensCell;\n}") },
    });
    const { context } = panelContext(files);
    const { host } = fakeHost();
    const controller = new OpenseWorkspaceController(host, context, parseOpenseWorkspace);
    controller.hostConnected();
    await settle();

    expect(controller.selectRow("Tracker::lens")).toBe(true);
    expect(controller.selectedId).toBe("Tracker::lens");
  });

  it("restores the deep-linked element after a parse", async () => {
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("model.sysml", "model.sysml")]) },
      reads: { "model.sysml": text("package Tracker {\n  part lens : LensCell;\n}") },
    });
    const { navigation } = createFakeNavigation({ query: { element: "Tracker::lens" } });
    const { context } = createPanelContext({ files: files.files, navigation });
    const { host } = fakeHost();
    const controller = new OpenseWorkspaceController(host, context, parseOpenseWorkspace);
    controller.hostConnected();
    await settle();

    expect(controller.selectedId).toBe("Tracker::lens");
  });

  it("ignores a stale/unknown deep-linked element id", async () => {
    const files = createFakeFiles({
      trees: { "": tree([fileEntry("model.sysml", "model.sysml")]) },
      reads: { "model.sysml": text("package Tracker {\n  part lens : LensCell;\n}") },
    });
    const { navigation } = createFakeNavigation({ query: { element: "Tracker::missing" } });
    const { context } = createPanelContext({ files: files.files, navigation });
    const { host } = fakeHost();
    const controller = new OpenseWorkspaceController(host, context, parseOpenseWorkspace);
    controller.hostConnected();
    await settle();

    expect(controller.selectedId).toBeUndefined();
  });
});

function fakeHost() {
  return { host: createFakeHost() };
}

/** Thin positional adapter over the shared `createPanelContext` builder. */
function panelContext(fake: FakeWorkspaceFiles): { context: WorkspacePanelContext; requestRender: ReturnType<typeof vi.fn> } {
  const { context, requestRender } = createPanelContext({ files: fake.files });
  return { context, requestRender };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}