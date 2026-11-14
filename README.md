# opense-plugin

OpenSE is a browser plugin for [pi-web](https://github.com/jmfederico/pi-web): it
parses SysML v2 models found in the workspace and renders diagnostics, a
model outline, and element details — entirely in the browser, no backend or
semantic validation.

## Prerequisites

this plugin is based on 
- [Pi Coding Agent](https://pi.dev)
- and [PI WEB](https://pi-web.dev/)

And it works best with the skills and tools from [bulb](https://github.com/kairibu/bulb) installed, however they require `syside`, a commercial sysml v2 tool by [sensmetry](https://www.sensmetry.com).

[Pi](https://pi.dev) is lightweight and saves context and tools and skills are kept simple to support on-prem, local AI models. It has been tested with Qwen3.6 and gpt-oss-120.

## Installation

1. Clone this repository.

2. Build the plugin. It will be created in `dist/`:
   
```sh
npm run build
```

3. Symlink `dist/` from this repository into pi-web's plugin
tree (pi-web handles symlinked plugin directories):

```sh
ln -s ./dist ~/.pi-web/plugins/opense
```

pi-web then discovers and serves the plugin.

### Installing from npm

Once published, the package is installable through **Settings → Pi packages**
by name. Community discovery on [pi-web.dev/community-plugins](https://pi-web.dev/community-plugins)
requires the `pi-web.dev-plugin` npm keyword, which this package declares in
`package.json` (alongside `pi-web`, `sysml`, `sysml-v2`, `mbse`). The peer
dependency `@jmfederico/pi-web >= 1.202611.1` documents the supported host
range.

The "Open .sysml links" toggle (OpenSE palette action) is a
**per-browser-device** `localStorage` preference, not a global one: pi-web
offers no settings context for browser-only plugins. Global enable/disable
remains available via **Settings → PI WEB plugins**.

## Reference chips in chat

Agents and users may write `[[Pkg::Wheel]]` in chat messages to point at
SysML elements worth inspecting: the chip renders as a small styled badge
(non-interactive — the host sanitizer strips links and handlers from plugin
markdown), and the message's **Open element in OpenSE** action opens the
element's detail pane in the workspace panel. A plain backticked
`` `Pkg::Wheel` `` works through the same action without the chip rendering.
When a message mentions several elements, the action opens a small chooser
overlay; a miss (the element is not in the current model) lands on an
honest "was not found in the current model" notice instead of a silent
no-op.

## Development

### Structure

All sources live under `src/`.

- `src/pi-web-plugin.ts` — browser entry point; default-exports the
  `PiWebPlugin` activation descriptor (apiVersion 5)
- `src/opense-panel.ts` — panel UI and contributions factory (lit custom
  elements; drives the parse on connect), including the "Open element in
  OpenSE" chat message action (C2)
- `src/opense-references.ts` — pure extraction of element references from
  chat text (backticked spans + `[[...]]` chips; shared chip grammar)
- `src/opense-panel-chips.ts` — the `[[Pkg::Wheel]]` markdown extension
  (reference chips in chat and Markdown previews, C4)
- `src/opense-panel-chooser.ts` — the chat-side candidate chooser overlay
  opened by the message action when a message carries several references
- `src/opense-panel-palette.ts` — action palette below the element details
  (custom element: Investigate, Task, and Copy name insert prompts
  into the session prompt editor)
- `src/opense-prompts.ts` — pure prompt builders used by the action palette
- `src/opense-shared.ts` — tiny cross-module helpers (`formatUnknownError`, the
  register-once custom-element guard) with no dependencies, so every module
  can import it without cycles
- `src/opense-contract.ts` — the single boundary to the vendored sysml-parser: loads
  the bundle, adapts its results to plugin-local shapes
- `src/opense-discovery.ts` — workspace file discovery (`*.sysml` sources)
- `src/opense-outline.ts` — model outline rows from the parser AST
- `src/test-support.ts` — shared test fixtures (in-memory workspace-files fake,
  entry/tree/content builders); excluded from the runtime build
- `src/vendor/sysml-parser.bundle.js` — committed browser bundle of the
  `sysml-parser` library (not shared yet)
- `src/vendor/sysml-parser.bundle.d.ts` — hand-written minimal type surface for
  what this plugin consumes (NOT generated)

### The piWeb manifest

`package.json` carries the plugin manifest for the pi-web catalog:

```json
"piWeb": {
  "plugins": [
    { "id": "opense", "browserRoot": ".", "module": "pi-web-plugin.js" }
  ]
}
```

The id `opense` must stay in sync with the directory name pi-web knows the
plugin under.

### NPM build and development

```sh
npm install
npm run build      # transpile TS + copy manifest/vendor -> dist/
npm run dev        # build in watch mode
npm test           # vitest (contract/discovery/outline/panel/plugin tests)
npm run typecheck  # tsc --noEmit
```

The build script (`scripts/build-plugin.mjs`) uses the exact transpiler
settings of pi-web's `scripts/build-plugins.mjs`, so `dist/` output is
equivalent to what pi-web materializes from a symlinked plugin
directory. Test files and `.d.ts` declarations are excluded from `dist/`
(types are checked by `typecheck`; the plugin loads only the runtime
bundle).

### The vendored sysml-parser bundle

The parser is a pre-built ESM bundle, committed here under
`src/vendor/`. The sysml-parser is a separate repository.
