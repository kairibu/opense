// @vitest-environment happy-dom
//
// Combined entry/panel test (the git entry-test pattern,
// pi-web-plugins/git/pi-web-plugin.test.ts): activates the bundled entry's
// default export with the activation context the host actually supplies
// (src/client/src/plugins/external.ts parsePluginModule → activate), then
// asserts the returned contributions carry the always-visible OpenSE panel
// and its two unconditional actions, and that the actions reach the host
// navigation/refresh entry points with the runtime-qualified panel id.
// Structural wiring only — rendered parse behavior lives in
// opense-panel.test.ts.

import { html, svg } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntimeContext, Workspace, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import plugin from "./pi-web-plugin.js";

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

describe("bundled OpenSE browser entry", () => {
  it("exports the host-expected plugin shape and contributes the panel and both actions", () => {
    expect(plugin.apiVersion).toBe(2);
    expect(plugin.name).toBe("OpenSE");
    expect(typeof plugin.activate).toBe("function");

    const contributions = activate("opense");
    const panel = contributions.workspacePanels?.[0];
    if (panel === undefined) throw new Error("Expected OpenSE workspace panel");
    const context = panelContext();

    // Browser-only plugin: panel is always visible, never ownership-gated.
    expect(panel.id).toBe("workspace.opense");
    expect(panel.title).toBe("OpenSE");
    expect(panel.order).toBe(60);
    expect(panel.icon).toBeDefined();
    expect(panel.visible?.(context)).toBe(true);
    expect(typeof panel.onInvalidate).toBe("function");
    expect(typeof panel.render).toBe("function");

    expect(contributions.actions?.map(({ id }) => id)).toEqual(["view.opense", "workspace.refresh-opense"]);
  });

  it("wires the two actions to host navigation/refresh with the runtime-qualified panel id", async () => {
    const contributions = activate("opense");
    const goToOpense = contributions.actions?.find((action) => action.id === "view.opense");
    const refresh = contributions.actions?.find((action) => action.id === "workspace.refresh-opense");
    if (goToOpense === undefined || refresh === undefined) throw new Error("Expected both OpenSE actions");

    expect(goToOpense.shortcut).toBe("mod+6");
    expect(goToOpense.group).toBe("Navigation");
    expect(refresh.shortcut).toBe("mod+shift+m");
    expect(refresh.group).toBe("Workspace");
    // Unconditional: no `enabled` gate at all (no provider ownership to gate on).
    expect(goToOpense.enabled).toBeUndefined();
    expect(refresh.enabled).toBeUndefined();

    const selectMainView = vi.fn<PluginRuntimeContext["selectMainView"]>();
    const refreshWorkspacePanels = vi.fn<PluginRuntimeContext["refreshWorkspacePanels"]>();
    const runtime = runtimeContext({ selectMainView, refreshWorkspacePanels });

    await goToOpense.run(runtime);
    expect(selectMainView).toHaveBeenCalledWith("opense:workspace.opense");

    await refresh.run(runtime);
    expect(refreshWorkspacePanels).toHaveBeenCalledWith("opense:workspace.opense");
  });
});

function activate(runtimePluginId: string) {
  return plugin.activate({ apiVersion: 2, pluginId: "opense", runtimePluginId, html, svg }).contributions;
}

function panelContext(workspace = openseWorkspace, machineId = "local"): WorkspacePanelContext {
  const noop = () => undefined;
  return {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    workspace,
    state: { selectedWorkspace: workspace, workspaceTool: "opense:workspace.opense", mainView: "opense:workspace.opense" },
    files: {
      readFile: () => Promise.reject(new Error("not implemented")),
      listFiles: () => Promise.reject(new Error("not implemented")),
      writeFile: () => Promise.reject(new Error("not implemented")),
      deleteFile: () => Promise.reject(new Error("not implemented")),
      moveFile: () => Promise.reject(new Error("not implemented")),
    },
    host: { requestRender: noop },
    prompt: { insertText: noop, getText: () => "", getSelection: () => null },
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