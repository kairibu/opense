// Browser entry point for the bundled OpenSE plugin. Pure wiring: the default
// export matches the host's load-time expectations (see
// src/client/src/plugins/external.ts parsePluginModule) and passes the
// activation context into the contributions factory, exactly like the
// info/git browser entries. All logic lives in opense-panel.ts; no paired
// server path exists because browser-only plugins never have one (v4 exposes
// an optional `peer?: PluginPeer` on WorkspaceContext, which OpenSE does not
// use).

import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { createOpenseBrowserContributions } from "./opense-panel.js";

const plugin: PiWebPlugin = {
  apiVersion: 4,
  name: "OpenSE",
  activate: ({ runtimePluginId, html, svg }) => {
    const { contributions, dispose } = createOpenseBrowserContributions(runtimePluginId, html, svg);
    // Keep activation synchronous; W2 adds the activation-result `dispose` so
    // the host's shutdown/rollback path releases the per-workspace registry
    // (aborting in-flight parses and dropping every cached model index).
    return { contributions, dispose };
  },
};

export default plugin;