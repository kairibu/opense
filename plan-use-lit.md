# Plan: Refactor OpenSE to Lit Elements

Status: draft · Build enablement complete, refactor not started.

## 1. Goal

Migrate OpenSE's browser UI from the current split architecture (host-injected
`HtmlTemplateTag` render functions + one purely imperative `HTMLElement`
subclass) to idiomatic Lit 3 elements: `LitElement` subclasses with reactive
properties, reactive controllers, scoped styles, and declarative templates.

Prerequisite — *already done*: `scripts/build-plugin.mjs` now esbuild-bundles
the entry (`bundle: true`, matching pi-web's `scripts/build-plugins.mjs`), so
bare npm imports such as `lit` inline into `dist/pi-web-plugin.js`. The
"plugin modules load without an import map" constraint that forced
`opense-panel-palette.ts` to stay imperative no longer holds.

## 2. Current state

| Module | Today |
| --- | --- |
| `src/pi-web-plugin.ts` | Entry; receives `html`/`svg` tags from the host and threads them into `createOpenseBrowserContributions`. |
| `src/opense-panel.ts` | ~640 lines: per-workspace UI-state controller (LRU, `retained` guard, stale/loading/error flags), in-browser parse job, and a family of pure `renderXxx(html, …)` functions producing `TemplateResult`s. Host decides when they re-run. |
| `src/opense-panel-palette.ts` | Imperative `HTMLElement` subclass (shadow-less, hand-built DOM, manual `addEventListener`, inline SVG string) — deliberately "no Lit" under the old build. |
| `src/opense-shared.ts` | `defineCustomElementOnce` double-registration guard (stays useful). |
| Styles | Global `opense-*` class names rendered into host DOM; no encapsulation. |

## 3. Target design

### 3.1 Elements

One custom element per UI region, each a `LitElement` with `static styles`:

- `<pi-web-opense-panel-activity>` (tag already reserved by
  `activityElementTag`) — status strip: stale badge, ok/issues chip, error
  alert. Reactive props: `loading`, `stale`, `error`, `reportOk`.
- `<pi-web-opense-panel-body>` — the main panel region; hosts the parse job
  trigger and composes diagnostics/outline/detail subviews. Owns or consumes
  the workspace UI state.
- `<pi-web-opense-action-palette>` (existing tag from
  `actionPaletteElementTag`) — rewritten from imperative DOM to Lit
  templates; behavior (filter, selection, shortcut activation) unchanged.
- Optionally `<pi-web-opense-outline>` and `<pi-web-opense-details>` if the
  body element grows too large; start monolithic, split on evidence.

### 3.2 Reactive controller

Promote `OpenseWorkspaceUiState` + the controller's LRU map into a formal
`ReactiveController` (`opense-panel-controller.ts`):

- Controller holds parse result, `loading`, `stale`, `error`, selection,
  kind filter, and the in-flight `parseRequest` reuse logic.
- State mutations call `host.requestUpdate()` — the hand-rolled
  "did state change, re-render the right region" plumbing in the current
  controller is deleted.
- `retained`/late-async-write guarding becomes `if (!host.isConnected) return;`
  after `await` points, plus the existing LRU eviction release.
- One controller instance per workspace, shared by activity/body elements
  via a `Context` provider or direct property passing (decide in §6.1).

### 3.3 Template tag injection

Phase the host coupling out, but do not break the plugin-api contract in the
same change as the refactor:

- Keep `createOpenseBrowserContributions(runtimePluginId, html, svg)` signature
  initially; the contributions factory can ignore the tags once nothing
  renders with them.
- Elements import `html`/`css` from `"lit"` directly (verified: bundles to
  ~21.7 KB unminified).
- In a follow-up, propose dropping `html`/`svg` from the plugin activation
  context for OpenSE (upstream question for pi-web: do any host features
  still require it?).

### 3.4 Rendering & DOM interop

- Directives: `repeat(rows, r => r.id, …)` for outline rows (selection
  survives re-sorts), `classMap`, `when`, `guard` around parse-result
  subtrees.
- Event handling via declarative `@click`/`@keydown` bindings; remove manual
  listener bookkeeping from the palette element.
- Shadow DOM: default `LitElement` render root. Panel copy currently relies
  on host-page CSS cascade in places — audit every `opense-*` rule during
  migration and move it into the owning element's `static styles`. If pi-web
  theming must reach into panels, expose CSS custom properties (`--opense-*`)
  at `:host` instead of keeping light DOM. Escape hatch if cascading host
  styles prove unavoidable: override `createRenderRoot()` to return `this`
  (documented deviation; loses encapsulation).

### 3.5 Registration

Keep `defineCustomElementOnce(tag, define)` from `opense-shared.ts` as the
registration guard (plugin modules can be evaluated more than once across
reloads); move element class declarations inside its callback as today.

## 4. Phases

### Phase 0 — build enablement ✅ (done)

- `scripts/build-plugin.mjs`: esbuild bundle of `src/pi-web-plugin.ts`,
  vendor parser kept external via `external`, manifest + vendor copied
  verbatim. Verified: 82/82 tests, `tsc --noEmit` clean, `lit` resolves
  (~21.7 KB unminified when inlined).

### Phase 1 — palette element to LitElement ✅ (done)

Smallest surface, proves the toolchain end to end.

- Rewrite `opense-panel-palette.ts` as `LitElement`; keep tag name, public
  behavior, and shortcut ids identical.
- Replace inline-SVG-string handling with lit `svg` templates or the existing
  static string (no functional change).
- Update `opense-panel-palette.test.ts` (see §5).

### Phase 2 — controller formalization

- Extract `OpenseWorkspaceUiState` + LRU into `ReactiveController`
  (`opense-panel-controller.ts`); panel module imports it, no behavior change.
- Parse job, discovery, contract code untouched — they are already
  framework-free.
- Unit-test the controller with a fake host (`{requestUpdate, isConnected}`),
  no DOM required.

### Phase 3 — activity + body elements

- Introduce the activity element as `LitElement`; wire to controller state.
- Convert `renderOpenseBody`/`renderDiagnostics`/`renderDiagnostic`/outline/
  detail render functions into element templates (or one body element with
  private template methods for v1).
- Delete the `html` tag threading through render signatures; keep the
  contributions factory signature (§3.3).

### Phase 4 — styles + cleanup

- Move `opense-*` CSS into `static styles`; introduce `--opense-*` custom
  properties for host-reachable theming.
- Remove the palette module's "purely imperative (no Lit)" header comment ✅
  (already refreshed during Phase 1 — the comment now describes the Lit
  implementation; nothing further to do) and the corresponding build-script
  history note (still pending).
- Follow up upstream on dropping `html`/`svg` from the activation context.

## 5. Testing

- Vitest + `happy-dom` stays the runner. Known sharp edge: happy-dom has had
  Lit reactive-update issues (vitest#2225, lit#3559 — fixed in current lit 3.x
  but re-verify). If element-level reactive updates flake, first try
  `await element.updateComplete`, then fall back to per-file
  `environment: "jsdom"` in vitest config.
- Element tests: instantiate the tag in a `happy-dom` document, set
  properties, assert on `shadowRoot` content. Prefer driving the controller
  directly for state logic (DOM-free) and reserving element tests for
  template/event wiring.
- Keep all existing pure-module tests (opense-outline, opense-contract,
  opense-discovery, opense-prompts) untouched — the refactor must not leak
  into parser/index logic.

## 6. Risks & decisions to resolve

1. **State sharing between activity and body elements** — controller instance
   per workspace must be reachable from both. Options: `@context`/`provide`
   from a wrapper element, or the panel module keeps a per-workspace
   controller map and hands instances to elements via properties (simpler,
   matches current LRU design — default choice).
2. **Shadow DOM vs. host theming** — if pi-web panel chrome styles cascade
   into plugin DOM today, Shadow DOM will cut that off; audit before Phase 4.
3. **Bundle duplication** — never bundle multiple entries per plugin; two
   copies of lit would mean two template caches and broken
   `instanceof LitElement`. Single-entry build already guarantees this.
4. **`HtmlTemplateTag` contract** — contributions factory keeps accepting
   (and ignoring) host tags until upstream agrees they are optional, so
   reverting a single commit restores the pre-refactor renderer.
5. **happy-dom update batching** — Lit's async microtask batching means
   assertions must `await updateComplete`; naive synchronous assertions will
   be flaky in review.

## 7. Definition of done

- No module in `src/` manipulates the DOM imperatively except through lit
  templates (`opense-shared.ts` feature checks excepted).
- All styles scoped via `static styles` / custom properties.
- Test suite passes under happy-dom; controller logic covered without DOM.
- `npm run build` output remains a single bundle with the vendored parser
  external; size delta attributable to lit (~22 KB unminified) documented in
  the README.
