# Implementation plan: OpenSE update — API v5, community discovery, chat → element links

**Status:** implemented — work items A–E landed 2026-11-14 (see git history for
the commit per item). D.3 dev-run checklist pending manual verification (see
§2.D.3 manual procedure).
**Date:** 2026-11-14
**Basis:** `notes/plan-v4-features.md` (W1–W4a shipped; W4b dropped), scout of
`../pi-web` @ `v1.202611.2`+17 (src/plugin-api.ts, registry.ts, workspaceLinks.ts,
FormattedText.ts, markdownExtensionHtml.ts, docs/plugins.md), npm dist-tags.

## 0. Decisions (confirmed)

1. **D1 — `.sysml` chat file links → OpenSE, configurable** (chosen:
   configurable). OpenSE declares `fileOpenQuery` and wins arbitration
   (order 7 < Files 10) by **default**; a per-browser preference lets users
   restore Files-preview behavior. Constraint discovered during planning:
   **browser-only plugins have no generic settings context** (docs/plugins.md:
   "Browser-only plugins do not yet receive an equivalent generic settings
   context"; `context.settings` is server-entry-only; Settings edits
   enablement only). Therefore the toggle is a **localStorage preference +
   palette action** (see C1), per-browser, not a host settings key. Shipping a
   server entry just for one setting stays out of scope (would force
   `machineSpecific`, `dataDirectory`, and give up the federated-safe
   in-browser parse — cf. plan-v4-features.md §0.4).
2. **D2 — element-reference convention: backticked qualified names only**
   (chosen: conservative). `` `Pkg::Wheel` `` in inline code spans; near-zero
   false positives; agents already write SysML names this way. Fenced code is
   excluded. Consequence for D3 (see below): inline code is a **protected
   surface** for markdown extensions ("Native inline code, fenced code, and
   indented code are protected from syntax extensions"), so chips cannot
   render backticked refs — C4 uses its own `[[Pkg::Wheel]]` syntax, and C2
   detects **both** forms so every chip is actionable.
3. **D3 — markdown extension chips: included** (chosen: include). Recognizes
   `[[Pkg::Wheel]]` inline syntax and renders a styled, non-interactive chip
   (host sanitizer removes links/handlers — chips are a visual affordance
   for C2's message action). Peer floor becomes **`>=1.202611.1`** (markdown
   extensions landed 1.202611.1).

## 1. Verified upstream facts (pi-web 1.202611.2)

- **v5 entrypoint** (`PiWebPluginV5`, `apiVersion: 5`) landed in **1.202610.5**
  (`0f6375d1`). v4 remains supported, contract frozen, one-time
  `console.warn` per plugin (registry.ts:551). No removal date set.
- **`routeAliases`/`navigationAliases` removed** (1.202611.0, `6ed051e7`) —
  OpenSE never used them; unaffected.
- **Message actions**: base API since **1.202610.2** (`00c964f`); V5 contexts
  (discovery-augmented) since 1.202610.5. `MessageActionContext` provides
  `machine`, `session`, `message { entryId, role, text }`, `prompt`,
  `navigate` (patch mode + destination query, since 1.202610.2 `4a45865`),
  `workspace?`, `files?`, `history`. `visible`/`enabled` must be synchronous,
  side-effect-free — no I/O.
- **Chat file links** (`workspaceLinks.ts` / `FormattedText.ts` /
  `PiWebApp.handleWorkspaceFileOpen`): href is classified to a
  workspace-relative path with `?`/`#` **stripped** (`split(/[?#]/, 1)`);
  plain left-click dispatches `workspace-file-open` →
  `resolveWorkspaceFileOpen` → first *visible* panel in `order` whose
  `fileOpenQuery(context, path)` returns a query wins. Modifier/new-tab clicks
  keep a download-URL href (server containment applies there). No client-side
  existence check on the plugin-open path.
- **Markdown extensions** (`MarkdownExtensionContribution`) landed
  **1.202611.1** (`5fb2259`). Presentation HTML is sanitized: `span`/`div`/
  `mark`/classes allowed; **links, handlers, custom elements removed**. Inline
  and fenced code are protected surfaces (backticked refs are *not* reachable
  by extensions). Extension output must be deterministic per raw token.
- **Panel order arbitration** is unchanged (`(order ?? 1000)` sorts); OpenSE's
  `order: 7` beats Files (10) and OpenDoor (5) — the W4b blocker "OpenSE never
  reached" is fixed (df6b6ed). The second W4b blocker (path-only payload)
  still stands: file links cannot carry an element id.
- **`WorkspacePanelNavigationV1`** unchanged: `query` / `set(key, value)`
  (returns a runtime boolean, `false` on stale route).
- **Community discovery** (`e42938f`, 1.202611.1): listings require the npm
  keyword **`pi-web.dev-plugin`**; the old `pi-web-plugin` tag no longer
  matches. OpenSE's package.json currently has **no `keywords` field**.
- Host floor mapping for the features used here: v5 entrypoint 1.202610.5;
  message actions 1.202610.2; navigate patch+query 1.202610.2; markdown
  extensions 1.202611.1; fileOpenQuery (v4 interface member) ≤1.202610.0.
  Running global install: **1.202611.1**; npm latest: **1.202611.2**.

## 2. Work items

### A — Migrate to browser API v5 (prerequisite for C2's V5 contexts; also removes the deprecation warning)

Mechanical, type-level; no behavior change expected (v5 panel/action shapes
are `Omit`-based supersets of v4 with discovery-augmented callback inputs,
which OpenSE's callbacks ignore).

1. `package.json`:
   - `peerDependencies`: `>=1.202611.1` (floor set by C4's markdown
     extensions, which landed in 1.202611.1; also matches the running host).
   - `devDependencies`: `@jmfederico/pi-web` `^1.202611.2`; re-lock.
   - (B lands in the same edit; see below.)
2. `src/pi-web-plugin.ts`: `apiVersion: 4` → `5`; result typed
   `PluginActivationResultV5`. Keep activation synchronous; keep the
   `{ contributions, dispose }` result (v5 keeps `dispose`).
   Activation context still provides `html`/`svg`/`runtimePluginId`; factory
   signature frozen as-is.
3. `src/opense-panel.ts`: swap contribution types —
   `PluginContributionsV5`, `WorkspacePanelContributionV5`,
   `PluginActionV5`. Callback bodies unchanged (`selectWorkspaceTool`,
   `refreshWorkspacePanels`, `onInvalidate`, `render` all exist on the V5
   contexts). Update the module-header comment block (v4→v5 references,
   "host-tag renderer" revert note stays).
4. `src/pi-web-plugin.test.ts`: shape assertions → `apiVersion: 5`;
   add an assertion that the activation result still carries `dispose`.
5. Comments/docs sweep: `AGENTS.md` unchanged (still accurate); README's
   version references updated; `notes/upstream-html-svg-tag.md` untouched
   (historical).

**Tests:** existing 119 stay green (pure type swap); plugin shape test updated.
**Acceptance:** `npm run typecheck && npm test && npm run build` green; dev-run
in pi-web shows no "deprecated API v4" console warning.

### B — Community discovery

1. `package.json`: add
   `keywords: ["pi-web.dev-plugin", "pi-web", "sysml", "sysml-v2", "mbse"]`.
   The `pi-web.dev-plugin` keyword is **required** for community listings.
   Re-check `docs/community-plugins.html` publishing instructions at
   implementation time for any additional metadata (description, icon).
2. Verify shipping fields already correct: `piWeb.plugins[]` (`id: opense`,
   `browserRoot: "."`, `module: pi-web-plugin.js`), `files: ["dist"]`,
   `main`, `repository`, `license`. `npm publish --dry-run` to confirm the
   tarball carries only `dist/` + `package.json` + `README.md` + `LICENSE`.
3. README: short "Discoverability" note (keyword requirement, install via
   Settings → Pi packages).

**Acceptance:** dry-run tarball sane; keyword present.

### C — Links from the chat transcript into OpenSE element details

Two supported surfaces compose into the feature (inline clickable element
links are **not** a supported plugin surface — see §1 sanitizer/link-policy
facts; do not attempt workarounds like `%23`-encoded fragments, they break the
modifier-click download href and any future client-side validation):

#### C1 — `fileOpenQuery`: `.sysml` chat links open OpenSE (file-level), configurable [D1]

- `src/opense-panel.ts` `createOpensePanel`: add
  `fileOpenQuery: (context, path) => openseClaimsSysmlLinks() &&
  path.toLowerCase().endsWith(".sysml") ? { file: path } : undefined`.
  Non-`.sysml` paths return `undefined` → Files (order 10) answers as before.
- **Preference (per-browser, D1):**
  - New tiny module `src/opense-preferences.ts`: `openseClaimsSysmlLinks()`
    reads `localStorage["opense.claimSysmlLinks"]` (default **on**;
    feature-checked — no DOM assumptions beyond the existing
    `defineCustomElementOnce` idiom, and safe in node tests where
    `localStorage` is absent);
    `setOpenseClaimsSysmlLinks(value)` writes it.
  - New palette action `opense.claim-sysml-links` (in `createOpenseActions`):
    "Open .sysml links in OpenSE" / “Open .sysml links in Files” — toggle
    title reflects current state; `run` flips the preference. No reload
    needed: `fileOpenQuery` reads it synchronously per click.
  - Scope caveat documented in README: the preference is **per browser
    device**, not global (browser-only plugins have no settings context —
    §0 D1). Global enable/disable remains available via Settings → PI WEB
    plugins.
- New query key `"file"` alongside the existing `"element"` key
  (both are local keys, `isContributionQueryLocalKey`-compatible —
  same namespacing as W4a's `opense--element`).
- `src/opense-panel-controller.ts`:
  - read `navigation.query["file"]` on parse completion;
  - if `element` absent and `file` present: select the first named row whose
    `declaringFile` matches the path (fail-safe: no match → no selection);
  - outline gains a subtle "filtered/highlighted by file" affordance? —
    minimal version: just select the first row of that file; a file filter
    chip is optional polish, decide during implementation.
- `notes/plan-v4-features.md` §0.2 (W4b dropped) gets a resolution note: both
  blockers re-evaluated; blocker 1 fixed by order 7, blocker 2 accepted as
  file-granularity (element granularity now delivered by C2 instead).

**Tests:** `opense-panel.test.ts` — fileOpenQuery returns `{file}` for
`.sysml`/`.SYSML` and `undefined` otherwise and while the preference is off;
the toggle action flips the read result; controller restores
file→first-row selection; `element` wins over `file` when both present.
**Acceptance:** agent writes `[wheel](models/wheel.sysml)` in chat → click
opens OpenSE with that file's first element selected; URL round-trips;
toggling the palette action restores Files-preview behavior without a reload.

#### C2 — Message action "Open element in OpenSE" (element-level)

- New module `src/opense-references.ts` — pure, no DOM/plugin-API imports
  (mirrors opense-outline style):
  - `openseReferenceCandidates(text: string): string[]` — extract qualified
    name candidates per D2: **backticked inline code spans** `` `Pkg::Wheel` ``
    plus **`[[Pkg::Wheel]]` chip syntax** (both conventions, so every C4 chip
    is actionable and backticked prose keeps working where chips are not
    written). Fenced code blocks are stripped first; inline `\```-escapes are
    not code spans; dedupe, order of first appearance; cap length (e.g. 50)
    and per-segment rules (`::`-separated identifier segments, optional
    leading `'` quoting — align with the parser's id grammar,
    `../sysml-parser/src/query.ts`). An inline span qualifies only if its
    whole content parses as a qualified name: `::`-segment count ≥ 2, each
    segment a valid SysML identifier (backticked `std::vector` is excluded
    by the grammar, not by case heuristics). Finalize the exact segment rule
    against real chat samples during implementation; conservative default:
    ≥ 2 segments, each a valid SysML identifier, first segment package-style.
  - `openseReferenceLabel(candidate): string` for palette rows.
  - `openseChipSyntax(text): { candidates, ranges }`-style helper shared with
    C4's tokenizer so detection and rendering cannot drift.
- `src/opense-panel.ts`: contributions gain
  `messageActions: [createOpenseElementAction(registry, panelId)]`:
  - entry action, `id: "chat.open-opense-element"`, title
    "Open element in OpenSE";
  - `visible({ message })`: `openseReferenceCandidates(message.text).length
    > 0` (pure sync — allowed);
  - `enabled({ workspace })`: `workspace !== undefined` (the session's cwd
    must map to a selected workspace; otherwise `disabledReason`:
    "Open the element's workspace first");
  - `run(context)`:
    1. candidates = extract from `context.message.text`;
    2. one candidate → navigate immediately;
    3. several → open the existing action-palette element
       (`opense-panel-palette.ts`) as a chooser overlay in the chat (it is a
       custom element; document/show-then-focus pattern), navigate on pick;
    4. `context.navigate({ view: "workspace", tool: panelId,
       query: { element: candidate } }, { mode: "patch" })` — the query
       lands in the panel's contribution-query namespace, exactly where
       W4a's controller reads it;
    5. return `MessageActionFeedback` (title "Opening Pkg::Wheel in OpenSE",
       1.2 s host toast).
  - Registry sharing: the message action closes over the same
    `OpenseWorkspaceRegistry` instance created in
    `createOpenseBrowserContributions` (no second parse path needed — the
    *panel* parses on navigation and resolves the name; see C3).
- Localization: none (English-only, consistent with the rest of OpenSE).

**Tests:** `opense-references.test.ts` (extraction cases: backticked spans,
`[[...]]` chips, fenced-code exclusion, dedupe, caps, backticked
`std::vector`-style non-SysML spans rejected); `opense-panel.test.ts`
(action shape, visible/enabled gates, markdown extension contribution
shape); `pi-web-plugin.test.ts` (messageActions + markdownExtensions present
in contributions).
**Acceptance:** agent message discussing `` `Vehicle::wheels` `` → action
visible → run → OpenSE opens with that element's detail pane; URL carries
`opense--element=Vehicle::wheels`.

#### C3 — Query-value resolution hardening in the controller

`navigationElementId` currently returns the raw query string and
`selectionIn` demands an exact visible row-id match. Chat-derived values are
qualified names that may differ from row ids in quoting. Extend the restore
step (`opense-panel-controller.ts`, parse-completion handler):

1. exact row-id match (unchanged, W4a fast path);
2. else, match named rows by `row.qualifiedName` (normalize quoting the same
   way `elementDetails`' byId→`get()` fallback does; reuse one shared
   normalizer so panel-selection and detail-resolution cannot drift);
3. else, no selection — and instead of failing silently, set a dismissible
   "Pkg::Wheel not found in the current model" notice state rendered above
   the outline (new controller field + element render branch; keeps the
   stale-URL fail-safe, adds honesty).

**Tests:** controller tests for all three resolution outcomes + notice
clears on next successful selection/parse.

#### C4 — Markdown extension: `[[Pkg::Wheel]]` reference chips [D3]

- `markdownExtensions: [{ id: "opense-refs", level: "inline", start, tokenize,
  render }]` recognizing **`[[Pkg::Wheel]]` inline syntax** →
  `<span class="opense-ref">Pkg::Wheel</span>` chip (host sanitizes; classes
  allowed).
- Inline code spans cannot be chipped (protected surface, §0 D2) — the
  `[[...]]` syntax exists precisely because of that; C2 detects both forms.
- Deterministic, escaped output (identical raw → identical HTML; host caches
  by raw text). `tokenize` returns `undefined` for anything that is not a
  complete well-formed `[[…]]` reference; `start` finds the earliest `[[`
  candidate offset. Invalid contents (not a qualified name) must **not** be
  consumed — return the raw text as plain so the host's own parser handles it.
- No click behavior possible — chip is a visual affordance for C2's action.
- Peer floor `>=1.202611.1` (already reflected in A.1).
- Prompt/README guidance: tell agents they may write `[[Pkg::Wheel]]` for
  elements they want the user to inspect (and plain `` `Pkg::Wheel` `` still
  works via the message action). No agent-side prompt file changes needed in
  this repo — `opense-prompts.ts` stays element-action-only; guidance lives
  in README.

**Tests:** tokenize/render unit tests (pure) incl. invalid-contents
pass-through and no-consumption of inline code; no host integration test
possible in-repo — verify in dev run (chat + Files Markdown preview).

### D — Housekeeping & verification

1. Version bump `0.1.0` → `0.2.0` (features + floor change).
2. Full gate: `npm run typecheck && npm test && npm run build`.
3. Dev-run checklist against a live pi-web (1.202611.x):
   - no v4 deprecation warning;
   - mod+6 / mod+shift+m unchanged;
   - W1/W4a regressions none (invalidation debounce, URL round-trip);
   - C1/C2/C3/C4 flows end-to-end incl. a remote-machine workspace;
   - `.sysml` modifier-click still downloads (host-owned href — verify
     unaffected by fileOpenQuery); preference toggle takes effect without
     reload;
   - `[[Pkg::Wheel]]` renders as a chip in chat and Files Markdown preview;
   - E: palette Investigate inserts `/opense-investigate …`; after sending,
     an independent **named** session works in the same workspace (incl.
     remote machine); Sessions list shows the labeled row with reopen /
     pin / archive; without the extension the line-2 instruction keeps the
     flow working inline.
4. Update `notes/plan-v4-features.md` §0.2 with the W4b resolution note (C1).

### D.3 — Manual dev-run checklist (live pi-web, to be executed by the user)

**Preamble:** this checklist requires a **live pi-web ≥ 1.202611.1 host and a
browser** — it cannot be run inside an agent session, and it must NOT be run
from one: agent sessions live inside the very session daemon under test, so a
restart/stop requested from an agent session would kill its own host. Any
daemon restart or stop needed before or during the run (e.g. to pick up a
newly installed package) must be issued **from a terminal, when safe**, never
from inside an agent session. No agent (including the D worker) performs any
live verification of these items.

Checklist (browser console + UI against the dev host):

- [ ] **No v4 deprecation warning** in the browser console on plugin load
      (API v5 migration, item A).
- [ ] **Shortcuts unchanged:** mod+6 opens the OpenSE panel, mod+shift+m
      opens the model overview (no regressions).
- [ ] **W1 invalidation debounce:** a burst of file edits coalesces into one
      re-parse (no thrash), and manual invalidation parses immediately.
- [ ] **W4a URL round-trip:** selecting an element puts `opense--element=…`
      in the URL, and a reload/restore of that URL re-selects it.
- [ ] **C1 `.sysml` links:** an agent-written `[wheel](models/wheel.sysml)`
      chat link opens OpenSE with that file's first element selected;
      the palette toggle ("Open .sysml links in OpenSE / in Files") takes
      effect **without a reload** and restores Files-preview behavior;
      modifier-click / open-in-new-tab still **downloads** the file
      (host-owned href, unaffected by `fileOpenQuery`).
- [ ] **C2 message action:** a chat message mentioning `` `Pkg::Wheel` `` (or
      several elements — chooser overlay) shows the **Open element in OpenSE**
      entry action; running it navigates to the element detail pane with the
      query in the URL. Includes `[[...]]` chips rendering **both in chat and
      in the Files Markdown preview** (C4).
- [ ] **C3 stale-name notice:** a URL/message reference to a name not in the
      current model shows the dismissible "not found in the current model"
      notice above the outline (no silent no-op; clears on next selection).
- [ ] **E dispatch flows:** palette **Investigate** / custom **Task** on an
      element detail inserts the composed two-line `/opense-investigate …` /
      `/opense-task …` command; after **Send**, an independent **named**
      session works in the same workspace — including on a **remote-machine**
      workspace; the initiating conversation receives the outcome message;
      the **Sessions list** shows the labeled row (**OpenSE investigate /
      task**) with **reopen** (deep-links the element), **pin**, and
      **archive/restore** controls. Without the extension installed, the
      line-2 instruction keeps the flow working inline (fallback).

**Implementation order:** A → B → C1 → C3 → C2 → C4 → E → D. (A is the
prerequisite for everything; E needs A's v5 backend contexts but is otherwise
independent of C; D closes.)

### E — Palette agent actions dispatch named sessions

**Status:** compared against opendoor's shipped solution (`../opendoor`
0.5.1) on 2026-11-14; architecture revised to the **opendoor pattern**;
decisions confirmed same day: **E-D1′ = opendoor pattern**, **E-D2′ = both
flows dispatch**.

**Want:** selecting an agent action in the OpenSE pane (Investigate /
custom task — currently `prompt.insertText()` into the current composer)
starts a **named session** that works as a dedicated investigator
("subagent") in the same workspace, plus **pin/archive** handling for the
spawned session — the capabilities the user named explicitly.

#### E.0 — Comparison: opendoor's solution vs the Workflows-pattern draft

**opendoor's "Start review session" flow** (sources: `src/pi-extension/opendoor-review.ts`,
`src/browser/sections/item-action-palette.ts` `insertReviewCommand`,
`src/doorstop-session-metadata.ts`, `src/browser/doorstop-session-labels.ts`,
`package.json`):

1. Palette click → `insertPrompt(composeReviewCommand(item))` →
   `context.prompt.insertText()` + `focusPrompt()`: inserts
   `/opendoor-review <UID>` on line 1 and the **self-sufficient instruction**
   on line 2. **The user presses Send.**
2. The package ships a **Pi extension** (`pi.extensions:
   ["./dist/pi-extension/index.js"]`) registering the `/opendoor-review`
   command. When the message is sent, the extension handler — running inside
   the initiating session — emits the host's **in-process dispatch bridge**
   channel `pi-web:session-dispatch:v1` with
   `{ input: { prompt, name, metadata }, accept }` and awaits the
   synchronously accepted promise.
3. The host bridge spawns an **independent session** with an **explicit
   `name`** ("Doorstop review " + UID, within the host's 60-char
   `requireInitialSessionName` bound) and **public `metadata`** (`opendoor`
   namespace, `{schema: 1, op: "review", uids}`) — exactly the two fields
   the `pi-sessions` v1 capability lacks.
4. Outcomes (success, rejected dispatch, malformed command, missing bridge)
   are reported into the initiating conversation as a **displayed custom
   message** (`opendoor-review-dispatch` customType); expected failures are
   never thrown.
5. A **`SessionLabelContributionV5`** renders a row indicator for every
   session carrying that metadata: a **reopen link** navigating back to the
   panel with the `uid` deep-link key, plus **pin/unpin, archive
   (busy-gated), restore** buttons via the optional `context.sessions`
   lifecycle (added 1.202610.9). The spawned session announces itself
   through this label — **no auto-navigation**.

opendoor's reason for the extension path is not the cycle rule's general
form: its server entry is a *workspace provider*, and the host rejects
provider-contributing entries that require late host capabilities
(`serverPluginRuntime.ts` provider-cycle rule), so capability-driven
dispatch could not live there. **OpenSE has no workspace provider, so the
Workflows pattern (paired server entry + `pi-sessions`) is also open to
us** — the choice is genuine:

| Aspect | Workflows pattern (former E draft) | **opendoor pattern (recommended)** |
| --- | --- | --- |
| Trigger | 1 click; dispatch immediate | click inserts `/opense-investigate …`; **user sends** |
| Session **name** | ❌ (prompt-craft via naming extension only; unnamed if that package removed) | ✅ explicit `name` in the bridge frame |
| Public **metadata** | ❌ | ✅ → powers labels |
| Session-list **label + reopen** | — | ✅ labeled row, reopen deep-links the element |
| **Pin / archive / restore** | ❌ not covered | ✅ lifecycle buttons on label rows |
| Auto-navigate to new chat | ✅ immediate | ❌ (outcome message + label) |
| Install/update friction | server entry: daemon restart + browser reload, revision pairing | extension ships in package; `/reload` per idle session |
| Host-internal API | none (public capability) | pinned channel literal `pi-web:session-dispatch:v1` (drift = rejected dispatch = intervention signal, opendoor discipline) |
| Fallback when dispatch unavailable | insertText when unpaired | line-2 instruction is self-sufficient (agent does the task inline) |
| New dependency | server entry + host capabilities | `@earendil-works/pi-coding-agent` **type-only** (ExtensionAPI), erased at build |

**Recommendation: opendoor pattern.** It delivers precisely the stated
wants (named sessions; pin/archive via labels), keeps OpenSE free of a
server entry entirely (browser entry + Pi extension only), and its fallback
discipline is strictly better. Accepted trade-offs: the user presses Send,
and opening the new session goes through the labeled session row rather
than an automatic navigation.

#### E-D decisions (confirmed 2026-11-14)

- **E-D1′ — opendoor pattern adopted.** Pi extension + host dispatch
  bridge; no server entry. The Workflows server-entry pattern stays
  recorded in E.0 as the rejected alternative (no name/metadata/lifecycle,
  install friction); the hybrid was rejected for complexity (two dispatch
  paths to test and document).
- **E-D2′ — both flows dispatch.** `/opense-investigate <element>
  [instruction…]` AND `/opense-task <element> <task…>`; the palette's
  Investigate and custom-task handlers both insert composed commands. The
  "name chip" flow stays plain composer assistance.

#### E1 — Package & extension (opendoor pattern)

1. `package.json`: add
   `"pi": { "extensions": ["./dist/pi-extension/index.js"] }`, keyword
   `"pi-package"`, devDependency `@earendil-works/pi-coding-agent`
   (type-only usage). No `serverModule`, no `machineSpecific` — OpenSE
   stays browser-entry + extension.
2. `scripts/build-plugin.mjs`: emit `dist/pi-extension/index.js` bundling
   `src/pi-extension/opense-dispatch.ts` **self-contained** (relative
   imports inlined; zero runtime host imports — `ExtensionAPI` type-only,
   opendoor discipline).
3. New `src/pi-extension/opense-dispatch.ts` (one module, two commands):
   - registers `/opense-investigate <element> [instruction…]` and
     `/opense-task <element> <task…>` (E-D2′);
   - pinned `PI_WEB_SESSION_DISPATCH_CHANNEL = "pi-web:session-dispatch:v1"`
     with opendoor's drift-is-intervention comment and a test asserting the
     literal against a duplicated expectation;
   - shared dispatch core (opendoor `runOpendoorReview` shape): strict
     metadata build (E3) → bridge frame
     `{ input: { prompt, name, metadata }, accept }` → await the accepted
     promise;
   - prompt: investigate = caller's instruction when present (the palette
     always supplies it — the words ARE the spawned prompt, verbatim), else
     the built-in `contextPrompt` instruction (bare-command fallback);
     task = the composed task text built from `editPrompt`
     (self-sufficient by construction);
   - name: `"OpenSE investigate " + element` / `"OpenSE task " + element`,
     hard-truncated to the host's 60-char bound (E3);
   - outcome reporting via `pi.sendMessage` displayed custom message (one
     shared `opense-dispatch` customType carrying the op in the content —
     simpler than two types; revisit if a transcript renderer arrives),
     tolerated-failure policy.

#### E2 — Browser palette changes

- `opense-prompts.ts` gains two command composers (line 1 command, line 2
  self-sufficient instruction — identical to opendoor's
  `composeReviewCommand` idiom):
  - `composeInvestigateCommand(file, subject)`: line 1
    `/opense-investigate <qualified-name>`, line 2 the existing
    `contextPrompt(...)` instruction (fallback when the extension is
    absent);
  - `composeTaskCommand(file, subject, task)`: line 1
    `/opense-task <qualified-name> <task>`, line 2 the existing
    `editPrompt(...)` instruction.
- `opense-panel-palette.ts`: the Investigate AND custom-task handlers call
  the insert path with their composed commands (instead of the bare
  prompts); the "name chip" flow (insert subject) is unchanged composer
  assistance.
- `opense-panel-elements.ts` `insertPrompt` wiring unchanged
  (`prompt.insertText` + `focusPrompt`).
- Status-bar/ask-run commit (opendoor `commitAskReview` analog) optional —
  decide during implementation whether the insert lands in the same
  run-outcome area.

#### E3 — Public session metadata + naming

- New `src/opense-session-metadata.ts` (no runtime imports; bundles into
  the extension): namespace `"opense"`, schema 1,
  `{ op: "investigate" | "task", elements: [qualifiedName] }` — the op
  enum ships BOTH values day one (unlike opendoor's single-value slice,
  which deferred growth). Strict builder (throws on junk; safe-token
  element grammar aligned with C2/C3's normalizer; bounds: 1..4 elements,
  ≤ 128 chars each) + tolerant parser (never throws; unknown
  schema/foreign namespace → `undefined`). Mirror
  `doorstop-session-metadata.ts` exactly.
- **Name**: `"OpenSE investigate " / "OpenSE task " + element`,
  hard-truncated to the host's 60-char bound
  (`requireInitialSessionName`: trimmed, non-empty, no control
  characters). Not dependent on the Session-naming package — an advantage
  over the former E3 prompt-craft strategy.
- Element identity note: the metadata/element uses the same qualified-name
  normalization as C3, so the label's reopen link and the panel's query
  resolution stay one grammar.

#### E4 — Session labels with pin/archive/restore (the user's explicit want)

- New `src/opense-session-labels.ts` — `SessionLabelContributionV5`,
  adapted from `doorstop-session-labels.ts` (copy its discipline comments
  verbatim where they apply):
  - `items(context)`: synchronous, side-effect-free; parses the detached
    row snapshot's `session.metadata["opense"]` via the tolerant parser; no
    item for absent/junk/future-schema rows; inner render item (not
    `link` — the reopen target is an internal `PluginNavigate`
    destination).
  - Reopen link → `context.navigate({ machineId, projectId, workspaceId,
    view: "workspace", tool: panelId, query: { element } })` reusing the
    W4a `element` key (C3's qualified-name resolution resolves it) —
    identical for both ops; the indicator text reflects the op
    ("OpenSE investigate" / "OpenSE task").
  - **Pin/unpin** toggle on every labelled row: reads live state via
    `context.sessions.get(...)` in the click handler, then `pin`/`unpin`.
  - **Archive** only on active rows (`session.archived === false`), refused
    while busy: read `catalog.sessions.get` for `runtime === "busy"` in the
    handler (fail-safe: "cannot prove idle" → refuse); **restore** only on
    archived rows.
  - `context.sessions` optional (older hosts): rows render the reopen link
    alone. Lifecycle promises fire-and-forget; buttons are real
    `<button type="button">` whose handlers stop the click.
- Wire the contribution in `createOpenseBrowserContributions` (needs
  `runtimePluginId` for the panel tool id — already available).

#### E5 — Docs

- README: the flow (palette → insert → send → labeled independent
  session), `/opense-investigate` and `/opense-task` usage incl.
  bare-command fallback,
  pin/archive buttons, extension `/reload` note, and the fallback behavior
  when the extension is not installed.
- `AGENTS.md`: note the Pi extension and the shared pure modules
  (`opense-prompts`, `opense-session-metadata`).

**Tests:** `opense-dispatch.test.ts` (arg parsing for both commands,
metadata build, bridge frame shape incl. per-op name/metadata,
accepted-promise await, outcome reporting — mirror
`opendoor-review.test.ts`); `opense-session-metadata.test.ts` (strict build
/ tolerant parse matrix across both op values);
`opense-prompts.test.ts` (both composed commands: line 1 command, line 2
self-sufficient instruction); `opense-session-labels.test.ts` (label items
for valid/absent/junk metadata, both ops; reopen destination; lifecycle
gates: busy-refusal, archived gating, optional sessions); palette tests for
both composed inserts.
**Acceptance:** click Investigate or submit a custom task on an element
detail → composer gains the composed `/opense-…` command + instruction;
after sending, an independent **named** session starts working in the same
workspace, the current draft is untouched, the outcome message appears in
the initiating conversation, and the Sessions list shows the labeled row
with reopen / pin / archive controls; without the extension the sent text
still instructs the current agent inline (line-2 fallback).

#### E risks

- **Host-internal channel literal** (`pi-web:session-dispatch:v1`): pinned,
  tested against a duplicated expectation, drift = rejected dispatch =
  charter intervention signal (opendoor discipline; same exposure opendoor
  already carries).
- **User presses Send**: the dispatch is user-mediated; the palette cannot
  submit the composer (no `submit` on `PluginPromptEditor`). Mitigation:
  insert + autofocus (existing behavior).
- **No auto-navigation**: opening the new session goes through the labeled
  row / outcome message. If wanted later, a transcript renderer for the
  outcome custom message (1.202611.0+) could add an affordance.
- **Extension availability**: requires the package installed as a Pi
  package and a `/reload` in the initiating session; the line-2 fallback
  keeps the flow functional without it.
- **No persona/tracked-child semantics** (unchanged): the dispatched
  session is an independent conversation; investigator behavior is
  prompt-established. Revisit if pi-web adds persona/child session APIs.
- **Upstream note** (was E3): with the opendoor pattern, name/metadata come
  free; the remaining upstream gap is browser-triggered dispatch with
  name/metadata (parity between `pi-sessions` v1 and the extension bridge)
  — file a pi-web issue, low priority now.

## 3. Risks / open questions

- **Remote machines:** message action `workspace` is present only when the
  session's cwd matches the selected workspace; `navigate` handles remote
  machine/project/workspace ids itself. Disabled-state copy covers the rest.
- **False positives** in candidate extraction: backticked-only (D2) keeps
  these rare, but backticked `std::vector` / Rust paths can still appear;
  the segment-grammar rule (§ C2) is the guard — calibrate against real
  chat samples during implementation.
- **`[[...]]` adoption** (C4): the syntax only pays off if agents/users know
  it; README carries the guidance, and backticked names keep working via C2
  regardless — chips are an affordance, not a requirement.
- **Per-browser preference scope** (C1): the `.sysml`-link toggle is
  localStorage-based and does not sync across devices or browsers; document
  clearly (host offers no browser-plugin settings context — §0 D1).
- **`fileOpenQuery` changes .sysml link behavior** for existing users
  (previously Files preview). Reversible by removing the callback; note in
  README.
- **Multiple plugins** answering fileOpenQuery: arbitration is order-then-
  first-answer; OpenSE answers only `.sysml`, so collisions are limited to
  other SysML tools (acceptable).
- **Streaming messages:** entry actions run per transcript entry; text is
  the committed entry text — extraction on streaming partials is not a
  concern for entry actions (displayed actions target committed slices).
- v5 deprecation horizon: none announced; revisiting when pi-web publishes a
  removal date.
- **E-specific risks** are listed at the end of item E.

