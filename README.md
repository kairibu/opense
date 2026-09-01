# opense-plugin

OpenSE is a browser plugin for [pi-web](https://github.com/kai/pi-web): it
parses SysML v2 models found in the workspace and renders diagnostics, a
model outline, and element details — entirely in the browser, no backend or
semantic validation.

This is a standalone repository; in the pi-web checkout it is consumed as a
symlinked plugin directory (see "Consuming from pi-web" below) and is
expected to become an installable pi-web plugin package in the future.

## Structure

- `pi-web-plugin.ts` — browser entry point; default-exports the
  `PiWebPlugin` activation descriptor (apiVersion 2) the host loads
- `opense-panel.ts` — panel UI and contributions factory (lit custom
  elements; drives the parse on connect)
- `opense-panel-palette.ts` — action palette below the element details
  (vanilla custom element: Investigate, Task, and Copy name insert prompts
  into the session prompt editor)
- `opense-prompts.ts` — pure prompt builders used by the action palette
- `opense-contract.ts` — the single boundary to the vendored parser: loads
  the bundle, adapts its results to plugin-local shapes
- `opense-discovery.ts` — workspace file discovery (`*.sysml` sources)
- `opense-outline.ts` — model outline rows from the parser AST
- `vendor/sysml-parser.bundle.js` — committed browser bundle of the
  [sysml-parser](https://github.com/kai/sysml-parser) library (generated)
- `vendor/sysml-parser.bundle.d.ts` — hand-written minimal type surface for
  what this plugin consumes (NOT generated)

## The piWeb manifest

`package.json` carries the plugin manifest the pi-web catalog discovers:

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
drop-in equivalent to what pi-web materializes from a symlinked plugin
directory. Test files and `.d.ts` declarations are excluded from `dist/`
(types are checked by `typecheck`; the plugin loads only the runtime
bundle).

## The vendored sysml-parser bundle

The in-browser parser is a pre-built ESM bundle, committed here under
`vendor/`. The sysml-parser repository owns the toolchain: it produces the
artifact with `npm run build:browser`
(`dist/sysml-parser.browser.js`, provenance banner, bundled chevrotain
version). To refresh the committed copy:

```sh
# in the sysml-parser repo:  npm run build:browser
cp ../sysml-parser/dist/sysml-parser.browser.js vendor/sysml-parser.bundle.js
```

Or, from the pi-web checkout, `npm run vendor:sysml` and copy the vendor
directory here. The bundle header records its provenance — do not edit it by
hand. When the parser gains API the plugin should use, also update the
hand-written `vendor/sysml-parser.bundle.d.ts`.

## Consuming from pi-web

Development setup: symlink this repository into pi-web's bundled plugin
tree (pi-web's build and runtime catalog both handle symlinked plugin
directories):

```sh
ln -s ../../opense-package /path/to/pi-web/pi-web-plugins/opense
```

pi-web then builds, serves, and discovers the plugin exactly as if the
sources lived in the checkout. As an installable package, the plan is to
publish this repository (drop `private`, finalize the package name) and
have pi-web install it into its plugin root.
