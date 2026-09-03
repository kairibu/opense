# Upstream question: make `html`/`svg` activation tags optional for browser plugins

**Status:** draft (cannot file upstream from this repository; written for the
maintainer / bundled into a pi-web follow-up).

**Date:** 2026-09-03 (with the OpenSE lit refactor, plan-use-lit.md §3.3/Phase 4)

## Context

pi-web's plugin activation context hands every plugin two host-injected
template tags:

```ts
activate: ({ runtimePluginId, html, svg }) => ({ contributions: ... })
```

Historically these were **required**: plugins rendered their UI by calling the
host's `html`/`svg` tags against host-managed template parts (the git panel
does this today).

## What changed for OpenSE

The OpenSE browser plugin (this repository) no longer renders with the host
tags at all. Its contributions factory still *accepts* them for a frozen
signature (a single revert restores the pre-refactor renderer — the kept
factory signature is plan-use-lit.md §3.3, the single-revert rationale is
§6 risk 4):

```ts
export function createOpenseBrowserContributions(
  runtimePluginId: string,
  html: HtmlTemplateTag,    // accepted-but-ignored
  svg: SvgTemplateTag,      // accepted-but-ignored
): PluginContributions
```

Every element renders with lit's own `html`/`svg`/`css` (imported from `lit`,
which plugin entries bundle). The panel icon uses lit's `svg` tag too.
Cross-copy rendering — a plugin-lit `TemplateResult` rendered by the host's
lit-html — is expected rather than proven by this repo's tests: lit-html
matches template results structurally (`strings` + `_$litType$`), not by tag
or package identity, so one lit copy can render another copy's result. This
repo's tests do not exercise the cross-copy path (they import `render` from
the *same* `lit` copy the plugin bundles); it surfaces only when the built
plugin actually loads in a live pi-web. Caveat for the maintainers: a page
carrying two separate copies of lit trips lit's dev-mode "Multiple versions
of Lit loaded" warning (`multiple-versions`; dev builds only — production
bundles omit the check), which is exactly the situation when the host UI
keeps its own lit (pi-web depends on `lit` ^3.3.3) next to the plugin's
inlined copy.

## Question for pi-web maintainers

Can `html`/`svg` become **optional** in the plugin activation context
(`activate` receives them only if the host still needs to provide them)?

- OpenSE provides a concrete in-tree example of a browser plugin that passes
  the tags through untouched.
- Do any host features still require the tags to be *present* (not just
  typed) on the context? E.g. does the host branch on `typeof html ===
  "function"`, or does any plugin-api type/test rely on them being passed?
- If they stay mandatory for a while (compat), the minimal follow-up is
  documentation that browser plugins may ignore them (see the OpenSE factory
  docstring).