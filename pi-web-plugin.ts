// Browser entry point for the bundled OpenSE plugin. Pure wiring: the default
// export matches the host's load-time expectations (see
// src/client/src/plugins/external.ts parsePluginModule) and passes the
// activation context into the contributions factory, exactly like the
// info/git browser entries. All logic lives in opense-panel.ts; no
// `context.backend` fallback path exists because browser-only plugins never
// have one (plan §3.3).

import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { createOpenseBrowserContributions } from "./opense-panel.js";

const plugin: PiWebPlugin = {
  apiVersion: 2,
  name: "OpenSE",
  activate: ({ runtimePluginId, html, svg }) => ({
    contributions: createOpenseBrowserContributions(runtimePluginId, html, svg),
  }),
};

export default plugin;