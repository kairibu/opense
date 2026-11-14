// Browser entry point for the bundled OpenSE plugin. Pure wiring: the default
// export matches the host's load-time expectations (see
// src/client/src/plugins/external.ts parsePluginModule) and passes the
// activation context into the contributions factory, exactly like the
// info/git browser entries. All logic lives in opense-panel.ts; no paired
// server path exists because browser-only plugins never have one (the
// plugin API exposes an optional `peer?: PluginPeer` on WorkspaceContext,
// which OpenSE does not use). Migrated to browser plugin API v5 (plan-v5
// §2.A): a type-level move
// only — v5 contribution/action/panel shapes are Omit-based supersets of
// their v4 counterparts with discovery-augmented callback inputs, which
// OpenSE's callbacks ignore — so the host's one-time v4 deprecation warning
// no longer applies and the entry is ready for v5-only features (C2's
// message-action contexts).

import type { PiWebPluginV5, PluginActivationResultV5 } from "@jmfederico/pi-web/plugin-api";
import { createOpenseBrowserContributions } from "./opense-panel.js";

const plugin: PiWebPluginV5 = {
  apiVersion: 5,
  name: "OpenSE",
  activate: ({ runtimePluginId, html, svg }): PluginActivationResultV5 => {
    const { contributions, dispose } = createOpenseBrowserContributions(runtimePluginId, html, svg);
    // Keep activation synchronous; W2 adds the activation-result `dispose` so
    // the host's shutdown/rollback path releases the per-workspace registry
    // (aborting in-flight parses and dropping every cached model index).
    return { contributions, dispose };
  },
};

export default plugin;