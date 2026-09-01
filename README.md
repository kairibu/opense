# opense-plugin

OpenSE is a browser plugin for [pi-web](https://github.com/jmfederico/pi-web): it
parses SysML v2 models found in the workspace and renders diagnostics, a
model outline, and element details — entirely in the browser, no backend or
semantic validation.

## Structure

All sources live under `src/`.

- `src/pi-web-plugin.ts` — browser entry point; default-exports the
  `PiWebPlugin` activation descriptor (apiVersion 2) the host loads
- `src/opense-panel.ts` — panel UI and contributions factory (lit custom
  elements; drives the parse on connect)
- `src/opense-panel-palette.ts` — action palette below the element details
  (vanilla custom element: Investigate, Task, and Copy name insert prompts
  into the session prompt editor)
- `src/opense-prompts.ts` — pure prompt builders used by the action palette
- `src/opense-shared.ts` — tiny cross-module helpers (`formatUnknownError`, the
  register-once custom-element guard) with no dependencies, so every module
  can import it without cycles
- `src/opense-contract.ts` — the single boundary to the vendored parser: loads
  the bundle, adapts its results to plugin-local shapes
- `src/opense-discovery.ts` — workspace file discovery (`*.sysml` sources)
- `src/opense-outline.ts` — model outline rows from the parser AST
- `src/test-support.ts` — shared test fixtures (in-memory workspace-files fake,
  entry/tree/content builders); excluded from the runtime build
- `src/vendor/sysml-parser.bundle.js` — committed browser bundle of the
  `sysml-parser` library (not shared yet)
- `src/vendor/sysml-parser.bundle.d.ts` — hand-written minimal type surface for
  what this plugin consumes (NOT generated)

## The piWeb manifest

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

## Build and development

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

## The vendored sysml-parser bundle

The parser is a pre-built ESM bundle, committed here under
`src/vendor/`. The sysml-parser is a separate repository.

## Installation

1. Build the plugin. It will be created in `dist/`.

2. Symlink `dist/` from this repository into pi-web's plugin
tree (pi-web handles symlinked plugin directories):

```sh
ln -s ./dist ~/.pi-web/plugins/opense
```

pi-web then discovers and serves the plugin.
