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

## Investigation and task sessions

The element detail pane's **Investigate** and **Task** actions compose a
two-line command and insert it into the prompt editor — the user presses
**Send**:

```
/opense-investigate Pkg::Wheel
Investigate Pkg::Wheel and summarise its structure, behaviour, and requirements. The element is located in models/wheel.sysml
```

When the OpenSE **Pi extension** is installed, sending that text starts an
**independent, named session** ("OpenSE investigate Pkg::Wheel") working in
the same workspace — a dedicated investigator/subagent conversation — and
the current conversation only receives a short outcome message. The second
line is the spawned session's prompt, verbatim. The custom-task action
works the same way through `/opense-task Pkg::Wheel` (the task text rides
in the line-2 instruction), and both commands can be typed manually:

```
/opense-investigate Pkg::Wheel [instruction…]
/opense-task Pkg::Wheel [task…]
```

The first token after the command is the element (a SysML qualified name,
whitespace-free — quoted segment names with inner spaces cannot be
dispatched); any remaining words become the spawned prompt verbatim. A bare
`/opense-investigate Pkg::Wheel` without trailing words uses a built-in
default instruction, so the command is self-sufficient either way.

Every dispatched session appears in the **Sessions list** with an OpenSE
row label (**OpenSE investigate** / **OpenSE task**) that reopens the
workspace panel with that element selected, plus **Pin** (protects the
session from cleanup), **Archive** (offered once the session is no longer
running), and **Restore** (on archived rows) buttons.

Notes and limits:

- The extension ships inside the package (`pi.extensions` in
  `package.json` → `dist/pi-extension/index.js`); it is loaded when the
  package is installed as a Pi package (npm or local source through
  **Settings → Pi packages**). After installing or updating the package,
  run `/reload` once in the initiating session to pick it up.
- **Without the extension the flow still works**: the current agent
  receives the whole two-line text, and the line-2 instruction is
  self-sufficient, so the investigation happens inline — only the
  independent named session, the outcome message, and the session-list
  label are extension features.
- The palette cannot submit the composer — the dispatch is user-mediated
  (insert + autofocus, then Send).

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
  and the Pi extension: the line-2 instructions, the composed two-line
  `/opense-investigate` / `/opense-task` commands, and the bare-command
  fallbacks
- `src/pi-extension/opense-dispatch.ts` — the Pi extension
  (built to `dist/pi-extension/index.js`): registers `/opense-investigate`
  and `/opense-task` and starts named independent sessions through PI WEB's
  session dispatch bridge
- `src/opense-session-metadata.ts` — the public `opense` session-metadata
  payload (strict builder + tolerant parser; shared by the extension and the
  session label, bundles into both)
- `src/opense-session-labels.ts` — the Sessions-list row label for
  dispatched sessions (reopen deep link + pin/archive/restore)
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

### The pi extension manifest

`package.json` additionally declares the Pi extension entry:

```json
"pi": {
  "extensions": ["./dist/pi-extension/index.js"]
}
```

The path is package-root-relative: Pi's package manager resolves it when
the package is installed as a Pi package (npm or local source). The build
strips the `pi` key from the generated `dist/package.json`, because dist/
serves as pi-web's plugin directory (symlink flow) and is never a Pi
package root.

### NPM build and development

```sh
npm install
npm run build      # bundle browser entry + Pi extension, copy manifest/vendor -> dist/
npm run dev        # build in watch mode
npm test           # vitest (contract/discovery/outline/panel/plugin/extension tests)
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
