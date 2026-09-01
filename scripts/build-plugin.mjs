#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Build the OpenSE pi-web plugin: transpile TypeScript sources to dist/ and
// copy non-TS assets (package.json manifest, vendor bundle) verbatim.
//
// Adapted from pi-web's scripts/build-plugins.mjs (single build target: this
// repository IS the plugin root; symlink materialization dropped — no build
// inputs are linked). The transpiler options are byte-identical to pi-web's,
// so dist/pi-web-plugin.js is drop-in equivalent whether it is built here or
// materialized through a symlinked plugin directory in the pi-web checkout.
//
// Output layout (dist/):
//   package.json            — verbatim copy; carries the piWeb.plugins
//                             manifest the pi-web catalog discovers
//   pi-web-plugin.js …      — transpiled sources ("// Generated from …")
//   vendor/sysml-parser.bundle.js — verbatim copy (committed vendor asset)
// Test files (*.test.ts), the shared test-support module, and .d.ts
// declarations are excluded, exactly like pi-web's build: types are checked by
// `npm run typecheck`, and the plugin loads only the runtime bundle.
//
// Usage: npm run build | npm run dev (--watch)
// ---------------------------------------------------------------------------

import { watch } from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const rootDir = resolve(import.meta.dirname, "..");
const outDir = resolve(rootDir, "dist");
const watchMode = process.argv.includes("--watch");
const cwd = process.cwd();

/** Root-level project files that never belong into the runtime dist/. */
const skippedNames = new Set([
  ".git",
  ".gitignore",
  "LICENSE",
  "README.md",
  "package-lock.json",
  "test-support.ts",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.config.mjs",
]);

if (isDirectExecution()) {
  if (watchMode) {
    await watchAndBuild();
  } else {
    await buildAll();
  }
}

async function buildAll() {
  await rm(outDir, { recursive: true, force: true });
  const result = await buildDirectory(rootDir, outDir);
  const suffix = result.transpiled === 1 ? "file" : "files";
  console.log(`[opense] built ${String(result.transpiled)} TypeScript ${suffix} into ${relative(cwd, outDir)}`);
}

async function buildDirectory(sourceDir, targetDir) {
  // realpath guard mirrors pi-web's build: a symlinked directory must never
  // recurse into its own ancestors (kept for safety even though no build
  // input is currently linked).
  const realSourceDir = await realpath(sourceDir).catch(() => undefined);
  if (realSourceDir === undefined) return { copied: 0, transpiled: 0 };

  const entries = await readDirectory(sourceDir);
  let copied = 0;
  let transpiled = 0;

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "scripts" || entry.name === "dist" || skippedNames.has(entry.name)) continue;
    const sourcePath = resolve(sourceDir, entry.name);
    const targetPath = resolve(targetDir, entry.name);

    if (entry.isDirectory()) {
      const result = await buildDirectory(sourcePath, targetPath);
      copied += result.copied;
      transpiled += result.transpiled;
      continue;
    }

    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".d.ts") || isTestSource(entry.name)) continue;

    if (isPluginSource(entry.name)) {
      await buildFile(sourcePath, targetPath.replace(/\.ts$/u, ".js"));
      transpiled += 1;
      continue;
    }

    if (entry.name.endsWith(".js") && await hasTypeScriptSource(sourcePath)) continue;
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    copied += 1;
  }

  return { copied, transpiled };
}

async function buildFile(file, outputPath) {
  const source = await readFile(file, "utf8");
  const transpiled = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      verbatimModuleSyntax: true,
      sourceMap: false,
      inlineSourceMap: false,
    },
  });

  const errors = (transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new Error(formatDiagnostics(errors));

  const output = `// Generated from ${relative(cwd, file)}. Do not edit directly.\n${transpiled.outputText}`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output);
}

/** Watch mode listens on the source tree; the realpath guard keeps a
 *  symlinked subdirectory from fanning out duplicate watchers. */
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

function isPluginSource(fileName) {
  return fileName.endsWith(".ts") && !fileName.endsWith(".d.ts");
}

function isTestSource(fileName) {
  return /\.(?:test|spec)\.ts$/u.test(fileName);
}

async function hasTypeScriptSource(javaScriptPath) {
  const typeScriptPath = javaScriptPath.replace(/\.js$/u, ".ts");
  try {
    await readFile(typeScriptPath, "utf8");
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
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
    watchers = (await findWatchDirs(rootDir)).map((dir) => watch(dir, () => scheduleBuild()));
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

function formatDiagnostics(diagnostics) {
  return diagnostics
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      return `${diagnostic.file?.fileName ?? "<unknown>"}: ${message}`;
    })
    .join("\n");
}

function isNodeError(error) {
  return error instanceof Error && "code" in error;
}
