# Implementation plan: pi-web v4 optional follow-ups (OpenSE)

**Status:** plan only — no implementation.
**Date:** 2026-10-05
**Basis:** `notes/migration-pi-web-plugin-api-v4.md` §4 (Optional v4 follow-ups),
scout inventory of this repo and `../pi-web` (browser plugin API v4,
`src/plugin-api.ts`), and decisions below.

## 0. Decisions (human-confirmed)

1. **Greenlight:** W1 (automatic invalidation), W2 (`dispose`), W3
   (abort-capable file reads), W4a (selection ⇄ navigation-query deep links).
   W4a delivers the "deep link to a SysML artifact opens it in the detail
   section" capability.
2. **W4b `fileOpenQuery`: dropped** (was: conditional). Two confirmed
   blockers in pi-web v4 (`../pi-web`):
   - Arbitration shadows opense: `resolveWorkspaceFileOpen`
     (`src/client/src/plugins/registry.ts:682`) iterates panels by `order`
     and returns the first visible panel whose `fileOpenQuery` yields a
     query. The bundled Files panel (order 10) answers `{ file: path }` for
     every path; opense (order 60) would never be reached. Shipping the
     opense side alone is provably dead code.
   - Link payloads cannot express element-level artifacts anyway:
     `workspaceMarkdownFilePath` (`src/client/src/formatting/workspaceLinks.ts`)
     strips `?`/`#` and delivers only a bare workspace-relative path — a
     `model.sysml` link cannot carry "which element". Even with arbitration
     fixed, the round-trip only knows the file.
   Revisit only if pi-web changes file-open arbitration (e.g. extension or
   service-worker based) or enriches link payloads.
3. **W5 `contentRenderers` for `.sysml`: dropped** — not wanted at the
   moment. Do not create `src/opense-content-renderer.ts`.
4. Item 6 of the migration note (server entry, `apiVersion: 3`) remains
   out of scope: not recommended by the note itself; would force
   `machineSpecific: true`, a persistent `dataDirectory`, and give up the
   federated-safe in-browser parse.

## 1. Shared scaffolding (Step 0 — do once, before W1)

- **0.1 Peer-floor verification.** Confirm every v4 symbol used below exists
  at the declared floor `peerDependencies >= 1.202609.1`
  (`../pi-web/src/plugin-api.ts`): `WorkspaceInvalidation`,
  `invalidationResources`, `onInvalidate` second argument, activation-result
  `dispose`, `WorkspaceFilesCapabilityV1` / `WorkspaceFileRequestOptions.signal`,
  `WorkspacePanelNavigationV1`. If any landed after `1.202609.1`, bump the
  floor in `package.json` and re-evaluate compat tagging
  (cf. `v0.1.0-piweb-1.202608`). Expected: no bump.
- **0.2 Fixture-builder consolidation.** Panel-context fixtures are
  duplicated in three places: `src/opense-panel.test.ts:458–483`,
  `src/opense-panel-controller.test.ts` (helper + `fakeHost()`),
  `src/pi-web-plugin.test.ts:96–110`. Move one `createPanelContext(overrides)`
  builder into `src/test-support.ts` with: optional
  `navigation?: WorkspacePanelNavigationV1` fake, optional `files` variant
  (legacy `WorkspaceFiles` vs capability-v1 fake), and an activation fixture
  capturing `dispose`. Each work item extends it incrementally.
- **0.3 Type imports.** Import v4 types (`WorkspaceInvalidation`,
  `WorkspaceFilesCapabilityV1`, `WorkspacePanelNavigationV1`) from the same
  module the repo already uses for panel/workspace types. Types only — no
  runtime imports from pi-web.

## 2. Work items

### W1 — Automatic invalidation with reason-aware parse gate (item 1)

**Value:** panel re-runs discovery + parse when `.sysml` files change or
agent work finishes; today only the manual Refresh action re-parses.

Changes:
- `src/opense-panel.ts` — `createOpensePanel` (~line 224): add
  `invalidationResources: ["workspace.files"]`; widen
  `onInvalidate: (context, invalidation?) => registry.invalidate(context, invalidation)`.
- `src/opense-panel.ts` — `OpenseWorkspaceRegistry.invalidate` (~line 165):
  accept optional `WorkspaceInvalidation`, forward to controller.
- `src/opense-panel-controller.ts` — `invalidate` (~line 137): accept the
  invalidation. **Gate design:**
  - `reason: "manual"` → parse immediately (existing Refresh semantics).
  - `reason: "mutation"` / `"agent-activity"` → trailing-edge debounce
    (~500 ms, restartable timer on the controller) so bursts coalesce into
    one parse.
  - Always set `stale = true` synchronously regardless of reason (cheap,
    keeps UI honest).
  - Keep the existing in-flight `parseRequest` join untouched.
  - Debounce constant as a named export so tests can use fake timers.

API contract: `plugin-api.ts:424–427,446,448`; host dispatch
`registry.ts:708–731` (mutation: `workspaceFiles.ts:43`; agent-activity:
`PiWebApp.ts:1586`; manual: `PiWebApp.ts:2315`); callbacks wrapped via
`publicContext.ts:58`.

Tests:
- `src/opense-panel.test.ts` (invalidate/stale tests ~196–217, ~394–417):
  `onInvalidate` invoked with and without an `invalidation` argument
  (backward compat).
- `src/opense-panel-controller.test.ts`: `mutation` invalidations within
  the debounce window → exactly one parse (fake timers); `manual` bypasses
  the debounce; `stale` set immediately for all reasons; burst after
  completion does not re-parse per event.
- `src/pi-web-plugin.test.ts` (~53–75): panel-shape assertions for the new
  `invalidationResources` field.

Acceptance: typecheck/test/build green; manual: edit a `.sysml` file (Files
panel or agent turn) → panel goes stale, then exactly one re-parse after the
burst; mod+shift+m still instant.

### W2 — `dispose(signal)` releasing the registry (item 2)

Changes:
- `src/opense-panel.ts` — `createOpenseBrowserContributions` (~line 113)
  returns `{ contributions, registry }` (or `{ contributions, dispose }`)
  instead of contributions only; adjust the "frozen signature" comment
  (~lines 116–117). Add `OpenseWorkspaceRegistry.release()`:
  iterate `workspaces.values()` → `controller.release()`, clear the map.
- `src/pi-web-plugin.ts` (~lines 11–18): capture the registry; add
  `dispose: () => registry.release()` to the activation result. Keep
  `activate` synchronous.

API contract: `PluginActivationResult.dispose` (`plugin-api.ts:81,88`);
host shutdown/rollback `registry.ts:191–219,543–550`; `adaptPublicPlugin`
binds `dispose` (`publicContext.ts:41`).

Tests: activation fixture calls `activation.dispose()` and asserts
controllers released (via factory return value / injected spy); registry
test that `release()` clears all cached workspaces.

Acceptance: typecheck/test/build green; manual: page reload in dev pi-web,
no console errors during plugin dispose. Hygiene win (browser-only plugin
is restart-free on reload).

### W3 — AbortSignal-capable file reads via capability detection (item 3)

Changes:
- `src/opense-discovery.ts` — widen `OpenseDiscoveryFiles` (~line 69):
  `listFiles(path, options?: { signal?: AbortSignal })`,
  `readFile(path, options?: { signal?: AbortSignal })`; thread options
  through `discoverOpenseFiles` → `flushPendingReads` (~lines 216/227).
- `src/opense-panel-controller.ts` — `OpenseParseJob` (~line 40) gains an
  options/signal param; `parse()` (~line 143) creates one `AbortController`
  per run. Capability detection is structural:
  `context.files.capabilityVersion === 1 ? { signal } : undefined`
  (host reference: `FilesRuntime.ts:631`). Abort on `release()` (~line 131)
  and on `hostDisconnected()`. **Do not** abort on superseding invalidation
  in this item — W1's debounce coalesces; join-and-reuse stays (see §4
  open question for the alternative).
- `src/opense-discovery.ts` — `applyReadResult` (~line 234): when the
  signal is aborted, drop the result silently (no error diagnostic);
  controller additionally keeps its late-write drop via
  `host.isConnected` (~line 157).
- `src/test-support.ts` — `createFakeCapabilityV1Files` variant:
  `capabilityVersion: 1` plus the v1 fields (`defaultUploadFolder`,
  `maxInlinePreviewBytes`, `previewUrl`, `downloadUrl`, `uploadFile`),
  with `readFile`/`listFiles` recording received signals.

API contract: `WorkspaceFileRequestOptions.signal` (`plugin-api.ts:266`),
`WorkspaceFilesCapabilityV1` / `WorkspaceFilesContextValue`
(`plugin-api.ts:316–330`); host forwards options (`workspaceFiles.ts:70–72`).

Tests:
- `src/opense-discovery.test.ts`: existing 20 tests stay green (optional
  options); new: signal forwarded; abort mid-batch drops remaining writes
  without error diagnostics.
- `src/opense-panel-controller.test.ts`: `release()` aborts the in-flight
  signal; legacy files (no `capabilityVersion`) never receive an options
  argument.

Acceptance: typecheck/test/build green; manual: rapid workspace switches
→ no late error diagnostics; per §5, verify the signal survives the host's
`adaptPublicPlugin` wrapping in a dev run, not only unit tests.

### W4 — Deep links to SysML artifacts in the detail section (item 4, W4a only)

Selection ⇄ navigation query; this is the "deep link opens the SysML
artifact in the detail section" feature:

- `src/opense-panel-controller.ts` — on `selectRow(id)` (~line 179) call
  `this.context.navigation?.set("element", id)` and **check the runtime
  boolean** (typed `void`, hosts return a failed-set boolean — mirror
  `TerminalBrowserRuntime.ts:134`). On parse completion, read
  `context.navigation?.query["element"]` and restore `selectedId` only if
  the id still exists in the new outline (today `selectionIn` clears
  selection); otherwise leave unset.
- Key must be a local key (`isContributionQueryLocalKey`) — `"element"`
  qualifies (`PiWebApp.ts:2262`). Host builds/restores namespaced keys as
  `${queryNamespace(contributionId)}--${key}` (`namespacedQueryArgs.ts`,
  `createWorkspacePanelNavigation` `PiWebApp.ts:2244`), so a shared URL
  round-trips only when workspace/machine identity matches (host handles
  this).
- Element-id stability (verified in the parser source,
  `../sysml-parser/src/query.ts:159–172`): ids are content-derived, not
  parse-order dependent — named elements get their (quoted) qualified name
  as `id`; unnamed elements get synthetic `<kind>` segment paths. The only
  position-derived component is the defensive `[n]` suffix, a per-parent
  counter over *same-label siblings only* (`Pkg::system[2]`, second
  `<doc>`); a deterministic parser reproduces identical ids for identical
  content. After a model **edit**, ids can legitimately shift (renames
  change qualified names; sibling reorder changes `[n]` indices) — the
  fail-safe rule (restore only when the id still exists in the new
  outline) guarantees such URLs select nothing rather than the wrong
  element. Document this behavior in the feature notes.

How it behaves for the user: select an element in the OpenSE panel → URL
gains `opense--element=<id>`; copy/paste the URL (or bookmark) → fresh tab
opens the workspace with that element selected in the detail section.

Out of scope / dropped: `fileOpenQuery` (decision §0.2). Clicking a
`model.sysml` link in chat/Files cannot route to the opense detail section
on current pi-web.

Tests: extend the shared `panelContext` builder (0.2) with a fake
`navigation` (`query` record + `set` spy returning `true`). Controller
tests: selection writes via `set`; failed `set` (false / navigation
undefined) leaves selection local-only; deep-link query restores selection
when the element exists; stale/unknown id ignored; no crash when
`context.navigation` is undefined (legacy hosts).

Acceptance: typecheck/test/build green; manual: select element → URL query
key appears; paste URL in a new tab → same element selected in details;
switching workspaces → no bogus selection. Add one deterministic re-parse
test in `src/opense-outline.test.ts`: parse identical model content twice,
assert identical outline id sets (guards against future parser changes
making ids order-derived).

## 3. Files to modify

- `src/opense-panel.ts` — contribution fields (`invalidationResources`),
  registry expose/release (W1, W2)
- `src/opense-panel-controller.ts` — invalidation gating, abort-capable
  parse, navigation selection sync (W1, W3, W4)
- `src/opense-discovery.ts` — options/signal params, abort handling (W3)
- `src/pi-web-plugin.ts` — add `dispose` (W2)
- `src/test-support.ts` — shared builders (W3, W4) [new file if it does
  not exist yet]
- `package.json` — only if 0.1 forces a peer-floor bump
- `notes/migration-pi-web-plugin-api-v4.md` — mark §4 items 1–3 done (and
  item 4 partial: query deep links shipped, `fileOpenQuery` rejected with
  the rationale) as they ship

New files: none (W5 cancelled).

## 4. Risks

- **W1 invalidation volume:** automatic invalidation fires per mutation
  and per agent-activity transition; the ~500 ms window is load-bearing —
  too short re-parses bursts, too long feels stale. `stale` immediate.
- **W4 `navigation.set` typing trap:** typed `void`, returns a runtime
  boolean — always check it.
- **W3 `adaptPublicPlugin` wrapping:** callbacks receive a projected public
  context; verify signal propagation in a dev run of `../pi-web`, not only
  unit tests.
- **W4 element-id semantics:** outline ids are content-derived (qualified
  names / `<kind>` paths; `[n]` only for same-name siblings), stable across
  deterministic re-parses of identical content — not parse-order counters.
  After an edit, a shared URL may select nothing (fail-safe; verified prefix
  key `"element"`, dropped `fileOpenQuery` with rationale).
- **Stale `dist/`:** production serves `~/.pi-web/plugins/opense → dist/`;
  rebuild before any reload-based verification (page reload suffices —
  browser-only plugin).

## 5. Validation checklist

1. Per work item: `npm run typecheck`, `npm test`, `npm run build`.
2. After each item: rebuild `dist/`, hard-reload the production pi-web
   (`127.0.0.1:8504`), confirm `pi-web-plugins/manifest.json` still lists
   `opense` and the console shows no plugin-load errors.
3. End-to-end pass after the last item: Refresh (mod+shift+m) instant;
   file edit → one coalesced re-parse; page reload → no dispose errors;
   deep-link URL round-trips to the detail-section selection; rapid
   workspace switches leave no stale diagnostics.
4. Regression: apiVersion-guard test still green; LRU and per-workspace
   state unchanged.

## 6. Remaining open questions (lower stakes now)

1. **Debounce window:** fixed ~500 ms trailing, or configurable? Skip
   `agent-activity` invalidations when the last parse is younger than N
   seconds?
2. **W3 abort semantics (later refinement):** abort an in-flight parse when
   a superseding parse starts, or keep join-and-reuse? (Join is cheaper;
   abort is more responsive on big workspaces.)
3. **Compat tagging:** expected none; if 0.1 forces a peer-floor bump,
   decide on a `-piweb-<ver>` tag alongside `v0.1.0-piweb-1.202608`.
