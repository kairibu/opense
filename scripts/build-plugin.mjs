#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Build the OpenSE pi-web plugin: esbuild-bundle the TypeScript entry from
// src/ into a single dist/pi-web-plugin.js, bundle the Pi extension from
// src/pi-extension/opense-dispatch.ts into dist/pi-extension/index.js, and
// copy non-TS assets (package.json manifest, vendor bundle) — the `pi` key
// stripped, see below.
//
// Adapted from pi-web's scripts/build-plugins.mjs (and opendoor's twin for
// the extension half): pi-web bundles each plugin entry with esbuild
// (`bundle: true`, browser/ESM/es2022 — see its buildFile), so plugin modules
// may import npm dependencies (e.g. `lit`) directly: they are inlined into the
// bundle and no host import map is required. This script applies the identical
// esbuild options to this repository's browser entry; the extension entry uses
// the node platform instead (Pi loads it as a Node ES module), with its only
// imports being the type-only `@earendil-works/pi-coding-agent` (erased at
// build) and same-package relative modules (inlined), so the shipped
// extension is self-contained and reaches no host internals.
//
// Output layout (dist/):
//   package.json            — repository-root manifest with the `pi` key
//                             STRIPPED (see below); carries the piWeb.plugins
//                             manifest the pi-web catalog discovers
//   pi-web-plugin.js        — bundled entry ("// Generated from …"): wiring +
//                             panel/palette modules + inlined npm deps
//   pi-extension/index.js   — bundled Node ESM Pi extension entry
//                             (`/opense-investigate` + `/opense-task` session
//                             dispatch; self-contained, zero bare imports)
//   opense-chips.css         — verbatim copy of src/opense-chips.css; the
//                             `stylesheets` contribution's module-relative
//                             URL (new URL("./opense-chips.css",
//                             import.meta.url).href) must resolve next to the
//                             bundle in the shipped layout, and esbuild
//                             never emits it (the plugin-api import is
//                             types-only; no TS module imports CSS)
//   vendor/sysml-parser.bundle.js — verbatim copy (committed vendor asset);
//                             kept external so the vendored parser stays
//                             diffable and is not duplicated into the bundle
//
// The manifest `pi` strip (opendoor discipline): `pi.extensions` paths are
// PACKAGE-ROOT-relative ("./dist/pi-extension/index.js") — Pi's package
// manager resolves them against the installed package root, which is correct
// for the npm/local-source package but would double-prefix when read from
// dist/ itself. dist/ is pi-web's plugin directory (symlink flow), never a Pi
// package root, so the dist manifest carries no `pi` entry at all.
//
// Test files (*.test.ts), the shared test-support module, and .d.ts
// declarations are excluded, exactly like pi-web's build: types are checked
// by `npm run typecheck`, and the plugin loads only the runtime bundles.
//
// Usage: npm run build | npm run dev (--watch)
// ---------------------------------------------------------------------------

import { watch } from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const rootDir = resolve(import.meta.dirname, "..");
const srcDir = resolve(rootDir, "src");
const outDir = resolve(rootDir, "dist");
const watchMode = process.argv.includes("--watch");
const cwd = process.cwd();

const entrySource = resolve(srcDir, "pi-web-plugin.ts");
const entryOutput = resolve(outDir, "pi-web-plugin.js");
const extensionEntrySource = resolve(srcDir, "pi-extension", "opense-dispatch.ts");
const extensionEntryOutput = resolve(outDir, "pi-extension", "index.js");

if (isDirectExecution()) {
  if (watchMode) {
    await watchAndBuild();
  } else {
    await buildAll();
  }
}

async function buildAll() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  // The extension lives in its own dist subdirectory (the root manifest's
  // `pi.extensions` path points at it); create it before esbuild writes.
  await mkdir(dirname(extensionEntryOutput), { recursive: true });
  await buildEntry();
  await buildExtensionEntry();
  // The plugin manifest lives at the repository root; dist/ needs it so the
  // pi-web catalog can discover the piWeb.plugins entry — with the `pi` key
  // STRIPPED (package-root-relative extension paths would double-prefix
  // from dist/; see the module header). Everything else stays verbatim.
  const manifest = JSON.parse(await readFile(resolve(rootDir, "package.json"), "utf8"));
  delete manifest.pi;
  await writeFile(resolve(outDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  // The chip stylesheet ships next to the bundle so the `stylesheets`
  // contribution's module-relative URL resolves in dist/ (see the layout
  // note above) — the copy is ours, esbuild only bundles the JS entry.
  await copyFile(resolve(srcDir, "opense-chips.css"), resolve(outDir, "opense-chips.css"));
  await copyDirectory(resolve(srcDir, "vendor"), resolve(outDir, "vendor"));
  console.log(`[opense] bundled ${relative(cwd, entrySource)} into ${relative(cwd, entryOutput)}`);
  console.log(`[opense] bundled ${relative(cwd, extensionEntrySource)} into ${relative(cwd, extensionEntryOutput)}`);
}

async function buildExtensionEntry() {
  // Node ESM bundle for Pi's extension loader (byte-identical options to
  // opendoor's extension build). The extension's only non-type import is the
  // same-package relative modules (opense-prompts, opense-session-metadata,
  // opense-references), so bundling inlines them and leaves ZERO bare
  // imports: the shipped entry is self-contained and reaches no host
  // internals.
  await build({
    entryPoints: [extensionEntrySource],
    outfile: extensionEntryOutput,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    sourcemap: false,
    absWorkingDir: cwd,
    logLevel: "silent",
    banner: { js: `// Generated from ${relative(cwd, extensionEntrySource)}. Do not edit directly.` },
  });
}

async function buildEntry() {
  // esbuild options byte-identical to pi-web's buildFile; `external` keeps the
  // vendored parser as a relative runtime import (mirrored src/ → dist/
  // layout makes the same specifier resolve in both trees).
  await build({
    entryPoints: [entrySource],
    outfile: entryOutput,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: false,
    absWorkingDir: cwd,
    logLevel: "silent",
    external: ["./vendor/sysml-parser.bundle.js"],
    banner: { js: `// Generated from ${relative(cwd, entrySource)}. Do not edit directly.` },
  });
}

async function copyDirectory(sourceDir, targetDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const sourcePath = resolve(sourceDir, entry.name);
    const targetPath = resolve(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || entry.name.endsWith(".d.ts")) continue;
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
  }
}

/** Watch mode listens on src/; the realpath guard keeps a symlinked
 *  subdirectory from fanning out duplicate watchers. */
async function findWatchDirs(dir) {
  const dirs = [];
  const visited = new Set();
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    const realCurrent = await realpath(current).catch(() => undefined);
    if (realCurrent === undefined || visited.has(realCurrent)) continue;
    visited.add(realCurrent);
    dirs.push(current);
    for (const entry of await readDirectory(current)) {
      if (entry.name === "node_modules") continue;
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const linkedRealpath = await realpath(path).catch(() => undefined);
        if (linkedRealpath === undefined) continue;
        const linked = await stat(linkedRealpath).catch(() => undefined);
        if (linked?.isDirectory()) pending.push(linkedRealpath);
        else if (linked?.isFile()) dirs.push(dirname(linkedRealpath));
      }
    }
  }
  return [...new Set(dirs)].sort((left, right) => left.localeCompare(right));
}

async function readDirectory(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function watchAndBuild() {
  let watchers = [];
  let timer;
  let building = false;
  let pending = false;

  const closeWatchers = () => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
  };

  const refreshWatchers = async () => {
    closeWatchers();
    watchers = (await findWatchDirs(srcDir)).map((dir) => watch(dir, () => scheduleBuild()));
  };

  const runBuild = async () => {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    try {
      do {
        pending = false;
        await refreshWatchers();
        await buildAll();
      } while (pending);
    } catch (error) {
      console.error("[opense] build failed:", error);
    } finally {
      building = false;
    }
  };

  const scheduleBuild = () => {
    clearTimeout(timer);
    timer = setTimeout(runBuild, 50);
  };

  await runBuild();
  console.log("[opense] watching for changes…");
  const shutdown = () => {
    closeWatchers();
    clearTimeout(timer);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Keep the process alive while watching.
  await new Promise(() => {});
}

function isDirectExecution() {
  const entryPath = process.argv[1];
  if (entryPath === undefined) return false;
  return pathToFileURL(resolve(entryPath)).href === import.meta.url;
}

function isNodeError(error) {
  return error instanceof Error && "code" in error;
}
