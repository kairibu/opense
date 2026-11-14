# Agents notes

`opense`is a pi-web plugin. is uses a pre-built sysml-parser. 

- See `../pi-web/AGENTS.md` and `../pi-web/docs/Plugins.md` for pi-web related information.
- See `../sysml-parser/README.md` for the source of the sysml-parser

The package ships TWO runtime artifacts (plan-v5 §2.E, opendoor pattern):

- a **browser-only pi-web plugin** (`piWeb.plugins` → `dist/pi-web-plugin.js`),
  and
- a **Pi extension** (`pi.extensions` → `dist/pi-extension/index.js`, built
  from `src/pi-extension/opense-dispatch.ts`): registers `/opense-investigate`
  and `/opense-task` and dispatches named independent sessions through PI
  WEB's host-internal session-dispatch bridge. It must stay SELF-CONTAINED —
  only type-only imports of `@earendil-works/pi-coding-agent` (erased at
  build) and same-package relative modules; never add a runtime dependency.

Shared **pure modules** are used by both halves and must stay free of DOM,
plugin-API, and Pi-runtime imports (they bundle into the browser entry AND
the extension bundle):

- `src/opense-prompts.ts` — the line-2 instructions, the composed two-line
  dispatch commands, and the bare-command fallbacks (the extension's
  prompt text MUST come from here, never be duplicated)
- `src/opense-session-metadata.ts` — the public `opense` session-metadata
  payload: strict builder (single validation source for element qualified
  names, built on the shared C2/C4 grammar in `opense-references.ts`) +
  tolerant parser (never throws)
