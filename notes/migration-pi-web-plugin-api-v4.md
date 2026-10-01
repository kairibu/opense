# Migration plan: OpenSE → pi-web plugin API v4 (browser) / v3 (server)

**Status:** plan only — no implementation.
**Date:** 2026-10-05

## 0. Repository locations

- **pi-web lives at `../pi-web`** (sibling of this repo) — that is the
  current and correct pi-web working copy; every pi-web path below is
  relative to it.
- All OpenSE paths below are relative to this repository
  (`/home/kai/Projekte/github/opense-package`).
- The plugin is wired into the production pi-web in one place:
  the installed local plugin at `~/.pi-web/plugins/opense` →
  `…/opense-package/dist/`. (The former bundled-style dev hookup — the
  `../pi-web/pi-web-plugins/opense` symlink — has been removed; there is
  no longer any opense file inside the `../pi-web` repository.)

## 1. Situation analysis

### What "latest pi-web" means here

- pi-web `origin/main` (in the `../pi-web` repository, `f24733e7`, release
  tag `v1.202610.0`) introduces
  **browser plugin API v4** (`src/plugin-api.ts`) and **server plugin API v3**
  (`src/server-plugin-api.ts`), shipped in release `1.202609.1`
  (commit `9505966`), refined in `1.202610.0`.
- There is **no compatibility shim**: the host rejects browser entries whose
  `apiVersion !== 4` (`src/client/src/plugins/external.ts::parsePluginModule`)
  and server entries whose `apiVersion !== 3`.
- **`../pi-web` has been updated to latest pi-web**: its `main` is now at
  `f24733e7` (tag `v1.202610.0`), and its working tree carries the target
  API: `../pi-web/src/plugin-api.ts` declares `apiVersion: 4`,
  `../pi-web/src/server-plugin-api.ts` declares `apiVersion: 3`.
  Migration proceeds directly against these on-disk contracts.
- Pull side effect to resolve: the pull stashed `../pi-web`'s local
  modifications into `stash@{0}` (`docs/plugins.md` OpenSE section diff,
  `package.json`, `vitest.config.ts`, `package-lock.json`). Decide in
  step 2.1 whether/when to re-apply the stash.
- The former bundled-style dev hookup (`../pi-web/pi-web-plugins/opense`
  symlink) has been removed. OpenSE now loads only through the installed
  local-plugin path (`~/.pi-web/plugins/opense` → this repo's `dist/`),
  which is also how it is used in production pi-web.
- The docs at `../pi-web/docs/plugins.md` (as committed on the new main) are
  the **new** reference: rewritten for v4/v3, with the API contract in
  `../pi-web/src/plugin-api.ts` / `../pi-web/src/server-plugin-api.ts` plus
  their tests, not the doc page. (The pre-pull OpenSE docs-section diff sits
  in `../pi-web`'s `stash@{0}`; re-apply it if the bundled-OpenSE docs entry
  should return, or accept the loss of that section for now.)

### What OpenSE is (migration surface)

OpenSE is a **browser-only** plugin: `piWeb.plugins` declares one browser
`module` (`pi-web-plugin.js`, esbuild bundle) with `browserRoot: "."`, and no
`serverModule`. It runs against the production pi-web as an installed local
plugin: `~/.pi-web/plugins/opense -> …/opense-package/dist/`.

Consequences:

- **No server entry exists, so there is no server-API v1→v3 migration work.**
  The plan documents the decision (below) to stay browser-only.
- The migration surface is one browser entry: `src/pi-web-plugin.ts`
  (`apiVersion: 2` → `4`), the two actions wired through
  `PluginRuntimeContext`, the panel contribution, and the test fixtures that
  hand-build activation/runtime/panel contexts.
- Packaging (`piWeb.plugins` metadata shape, `browserRoot`, catalog scanning)
  is **unchanged** in v3-era pi-web: the catalog accepts
  `{ id, module?, browserRoot?, serverModule?, machineSpecific?, defaultEnabled? }`.
  OpenSE's entry stays valid as-is. Package limits (4 096 entries / 16 MiB)
  are trivially satisfied by `dist/`.

## 2. Required changes (blocking, in order)

### 2.1 Update the dependency baseline

- `package.json` devDependencies: `@jmfederico/pi-web`
  `^1.202608.2` → `^1.202610.0` (first v4 release: `^1.202609.1`).
- `package.json` peerDependencies: `@jmfederico/pi-web`
  `>=1.202608` → `>=1.202609.1` (below this the host rejects the v4 entry).
- Run `npm install` in this repo; refresh `package-lock.json`
  (`node_modules/@jmfederico/pi-web` still holds 1.202608.2 types until
  then).
- `../pi-web` is already at latest (`f24733e7`, `v1.202610.0`) — no pull
  needed. One follow-up there:
  - The pre-pull local modifications sit in `stash@{0}`. Review them and
    re-apply (`git -C ../pi-web stash pop`, or selectively) only if the
    OpenSE docs section and the local test tweaks are still wanted; check
    for conflicts against the rewritten `docs/plugins.md` first.
- `../pi-web`'s own build artifacts (`dist/pi-web-plugins/` etc.) still
  predate the pull. That no longer matters for opense (it is no longer part
  of pi-web's bundled tree), but if you smoke-test against a dev run of
  `../pi-web` instead of the installed production instance, rebuild pi-web
  first so the host and its bundled plugins match the updated sources.

### 2.2 Entry point: `src/pi-web-plugin.ts`

- `apiVersion: 2` → `apiVersion: 4`.
- `activate` may stay synchronous and keep returning `{ contributions }`;
  `start()`/`dispose()`/`requires`/`provides` are all optional in v4. The
  `runtimePluginId`, `html`, `svg` context fields still exist unchanged, so
  the `createOpenseBrowserContributions` call keeps its frozen signature
  (see `notes/upstream-html-svg-tag.md` — the accepted-but-ignored tags
  remain host-injected in v4).
- New in the activation context (no action required): `signal` and
  `lifetimeSignal` AbortSignals.
- Update the stale header comment that references `context.backend` — in v4
  the paired-server concept on `WorkspaceContext` is `peer?: PluginPeer`
  (replaces v2's `backend?: WorkspaceBackend`). OpenSE never uses it.

### 2.3 Action "Go to OpenSE": `selectMainView` is narrowed

In v4, `PluginRuntimeContext.selectMainView(view)` accepts only
`"navigation" | "chat" | "workspace"`; a qualified contribution id is no
longer a valid main-view value (`PluginRuntimeState.mainView` narrows the
same way). `src/opense-panel.ts:208` currently does
`context.selectMainView(panelId)` — invalid under v4 types and a no-op
mis-route at runtime.

**Change:** `run: (context) => { context.selectWorkspaceTool(panelId); }`.
`selectWorkspaceTool(panelId)` exists in both v2 and v4 and is the documented
v4 way to "select and show a particular tool" (opens the workspace view with
`tool=<qualified id>`). Alternative: `await context.navigate({ view:
"workspace", tool: panelId })` — same effect, richer routing semantics, but
synchronous `selectWorkspaceTool` matches the action's current shape.

The "Refresh OpenSE" action (`refreshWorkspacePanels(panelId)`) is unchanged;
that API survived into v4.

### 2.4 Test fixtures and expectations

Typecheck will force these; enumerate them so the test churn is planned, not
discovered:

- `src/pi-web-plugin.test.ts:35` — `expect(plugin.apiVersion).toBe(2)` → `4`.
- `src/pi-web-plugin.test.ts:83` — fake activation context
  `{ apiVersion: 2, … }` → `apiVersion: 4`.
- `src/opense-panel.test.ts:85–89` (and the mirror in
  `pi-web-plugin.test.ts`) — action wiring assertion changes from
  `selectMainView("opense:workspace.opense")` to
  `selectWorkspaceTool("opense:workspace.opense")`; the
  `vi.fn<PluginRuntimeContext["selectMainView"]>()` handles move accordingly.
- Every hand-built `PluginRuntimeContext` / `WorkspacePanelContext` fixture
  needs the now-required `navigate` member
  (`navigate: vi.fn(() => Promise.resolve())` or a no-op). Affected: the
  fixture builders in `opense-panel.test.ts`,
  `opense-panel-controller.test.ts`, `opense-panel-elements.test.ts`,
  `opense-panel-palette.test.ts`, `pi-web-plugin.test.ts`.
- `mainView: "opense:workspace.opense"` in state fixtures
  (`opense-panel-controller.test.ts:272`,
  `opense-panel-elements.test.ts:241`, `opense-panel.test.ts:475/486`) →
  `mainView: "workspace"` to match the narrowed union type.
- No changes needed in `opense-discovery`, `opense-outline`, `opense-contract`
  or the vendored parser: they are host-API-agnostic (the `files` adapter is
  a structural subset of `context.files`, which keeps working — see §3).

### 2.5 Version-guard test

Add one regression test mirroring the host's loader check: default export has
`apiVersion === 4`, non-empty `name`, and a `activate` function. This is the
exact predicate `parsePluginModule` runs; failing fast in CI prevents
re-deploying an unusable build.

## 3. No-change items (verify, don't touch)

- **`context.files` shape.** v4 types it as
  `WorkspaceFilesContextValue = LegacyWorkspaceFiles | WorkspaceFilesCapabilityV1`.
  Both variants carry the five v2 methods; OpenSE's discovery adapter uses
  only `listFiles` + `readFile`, which keep their signatures. The legacy
  variant is what hosts serve "before capability versioning", so the panel
  code needs no change.
- **Panel contribution surface.** `id`, `title`, `icon`, `order`, `visible`,
  `badge`, `onInvalidate`, `render` are unchanged; `onInvalidate` gains an
  optional second `invalidation` argument (safe to ignore).
- **Build pipeline.** `scripts/build-plugin.mjs` (esbuild browser/ESM bundle
  with `lit` inlined, vendor bundle copied verbatim) is unaffected.
- **`piWeb.plugins` manifest.** Unchanged shape; browser-only entry stays
  non-`machineSpecific`. (Rule to remember for later: a paired browser +
  server plugin **must** be `machineSpecific: true`.)
- **Docs.** The OpenSE section in `../pi-web/docs/plugins.md` (local
  uncommitted diff in `../pi-web`) makes no version claims. This repo's
  `README.md` says "apiVersion 2" in one line and `AGENTS.md` points at
  `../pi-web` docs — update the README line as part of the
  implementation PR.

## 4. Optional v4 follow-ups (not part of this migration; record as candidates)

Ordered by value for OpenSE:

1. **`invalidationResources: ["workspace.files"]` on the panel** — v4 lets a
   panel declare fixed workspace resources and receive *automatic*
   `onInvalidate(context, invalidation)` calls with
   `{ reason, resources }` (`manual | mutation | agent-activity`). This
   would make the panel re-run discovery + parse when `.sysml` files change
   or agent work finishes — today only the manual Refresh action re-parses.
   The controller's parse job would need a cheap reason-aware gate to avoid
   reparsing on every file mutation burst.
2. **`dispose(signal)`** in the activation result to release the
   `OpenseWorkspaceRegistry` (all cached model indexes) on browser-host
   shutdown instead of relying on LRU eviction only.
3. **AbortSignal-capable file reads.** With capability detection
   (`files.capabilityVersion === 1`), `listFiles`/`readFile` accept
   `{ signal }`; discovery could abort an in-flight parse when the
   workspace switches or the panel is invalidated/evicted.
4. **Deep links.** `WorkspacePanelNavigationV1`
   (`context.navigation.query` / `.set(key, value)`) enables shareable URLs
   for a selected model element; `fileOpenQuery(context, path)` would let
   chat file links / Files open a `.sysml` file into the OpenSE panel.
5. **`contentRenderers`** contribution: a `.sysml` / SysML-fence renderer
   (outline or formatted text preview) for chat and Files via the new
   content-rendering capability — natural browser-only fit.
6. **Server entry later, if ever:** would mean `apiVersion: 3` +
   `ServerPluginPeer` (`peer`) or a `WorkspaceProvider`, a persistent
   `dataDirectory`, and forced `machineSpecific: true`. Documented here so
   nobody reuses `apiVersion: 1` server shapes; not recommended now (the
   in-browser parse keeps OpenSE simple, federated-safe, and restart-free).

## 5. Risks

- **Old-host breakage is intentional.** After this migration OpenSE requires
  pi-web `>= 1.202609.1`; on older pi-web the plugin fails to load with an
  explicit "Unsupported browser plugin API version … (expected 4)" error in
  the console. The peerDependency floor documents this; decide explicitly
  whether to keep a v2-era branch/tag (e.g. tag `v0.1.x-piweb-1.202608`)
  before pushing the breaking bump.
  - **Decision (2026-10-05):** keep the v2-era code reachable — tag
    `v0.1.0-piweb-1.202608` on the last pre-migration commit (the v2 tree at
    `3a0cd96`) before the breaking peer bump leaves `main`. No v2-era
    branch is kept; the tag is enough to check out or re-branch from for
    hosts still on pi-web `1.202608.x`.
- **Typecheck before `npm install`** in this repo is meaningless (the
  installed 1.202608.2 types are still v2) — run 2.1 first.
- **Stash in `../pi-web`**: `stash@{0}` holds the pre-pull local
  modifications (OpenSE docs section, `package.json`/`vitest.config.ts`
  tweaks). Popping it blind onto the rewritten `docs/plugins.md` may
  conflict; re-apply selectively or drop it deliberately.
- **Stale `../pi-web` build**: the on-disk `dist/pi-web-plugins/` manifest
  predates the pull; a smoke test without a rebuild runs old plugin code
  against the new host. Rebuild before validating.
- The 235-commit gap included host-side rewrites (parallel module
  loading, `adaptPublicPlugin` public-context wrapping) that change runtime
  behavior around callbacks. Verify behavior against a dev run from
  `../pi-web`, not just unit tests.
- **Production hookup only**: OpenSE now reaches the host exclusively via
  `~/.pi-web/plugins/opense` → `dist/`. The removed bundled-style symlink
  means there is no second path to catch regressions; a stale `dist/` is
  what production serves, so `npm run build` here must run before any
  reload-based verification.
- **Panel/shortcut environment changed**: the updated pi-web now ships new
  bundled plugins (`files`, `mermaid`, `terminal`) that occupy different
  panel slots. OpenSE's `order: 60` and shortcut `mod+6` should be
  re-checked against the new core/shortcut set now that the tree is
  updated (the collision analysis in `createOpenseActions` cites the old
  trees).
  - **Resolved (2026-10-05):** re-checked against pi-web `v1.202610.0`.
    Claimed bindings there are core `mod+1`/`mod+k`/`mod+,`/`mod+enter`/
    `mod+.`/`mod+g c`, bundled files `mod+2`/`mod+shift+f`, git `mod+3`/
    `mod+shift+g`, terminal `mod+4`, and PiWebApp `mod+shift+r`/`mod+g
    m/p/w/s`. `mod+6` and `mod+shift+m` remain unclaimed; the
    `createOpenseActions` comments now cite this tree.
- **Browser-host lifecycle differences**: v4 activation/start/dispose
  boundaries are host-bounded and plugin callbacks are wrapped through
  `adaptPublicPlugin` (public state projection). OpenSE uses only documented
  state, so exposure risk is low, but re-run the manual smoke test below.

## 6. Validation checklist

1. `npm run typecheck`, `npm test`, `npm run build` in this repo.
2. Against the running production pi-web (v1.202610.0): open the app and
   verify the `pi-web-plugins/manifest.json` endpoint lists the `opense`
   entry (served from the `~/.pi-web/plugins/opense` local-plugin path);
   reload the page and check the browser console for plugin-load failures
   (a v2 build shows the explicit "Unsupported browser plugin API version
   … (expected 4)" error).
3. Behavior: "Go to OpenSE" opens the OpenSE workspace tab
   (URL gets `view=workspace&tool=<runtimePluginId>:workspace.opense`);
   "Refresh OpenSE" (mod+shift+m) re-runs discovery + parse; panel renders
   diagnostics/outline/details for a workspace with `.sysml` files; empty
   state without them; switching workspaces and panel switches keep per-
   workspace state (LRU behavior intact).
4. Re-test after any rebuild of `dist/`: browser-only plugin → a page
   reload is enough (no session-daemon restart needed); confirm the served
   module URL actually changed (cache-busting/hard reload) so production
   does not keep serving the previous bundle.
5. Regression: apiVersion-guard test (§2.5) green; old build (apiVersion 2)
   would fail it.

### Status (2026-10-05)

- Items 1 and 5 pass (`npm run typecheck`, `npm test` 9 files / 94 tests,
  `npm run build`; the apiVersion-guard test is green).
- Item 2 checked against the running production pi-web at
  `http://127.0.0.1:8504`: `pi-web-plugins/manifest.json` lists the `opense`
  entry (`source: local`, `module: /pi-web-plugins/opense/pi-web-plugin.js`)
  and the served module reports `apiVersion: 4`, so there is no
  unsupported-version load failure.
- Items 3 and 4 (interactive browser behavior: workspace tool routing,
  refresh, per-workspace LRU, cache-busting) still need a manual browser
  pass — not covered by the automated gates.
