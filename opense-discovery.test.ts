// Layer 2 (node env): OpenSE discovery — bounded *.sysml walk through the
// injected files adapter. The fake adapter is intentionally structural, the
// same way the real `context.files` satisfies `OpenseDiscoveryFiles` without
// importing the host API.

import { describe, expect, it, vi } from "vitest";
import {
  MAX_CONCURRENT_READS,
  MAX_DISCOVERY_DEPTH,
  MAX_DISCOVERY_ENTRIES,
  MAX_DISCOVERY_FILES,
  discoverOpenseFiles,
  type OpenseDiscoveryFileContent,
  type OpenseDiscoveryFiles,
  type OpenseDiscoveryFileTree,
  type OpenseDiscoveryTreeEntry,
} from "./opense-discovery.js";

describe("opense discovery", () => {
  it("collects nested .sysml files (case-insensitive), sorted by path, skipping other files and symlinks", async () => {
    const { files, readCalls } = createFakeFiles({
      trees: {
        "": tree([
          dirEntry("model", "model"),
          fileEntry("a.txt", "a.txt"),
          fileEntry("Model.SYSML", "Model.SYSML"),
          symlinkEntry("link.sysml", "link.sysml"),
        ]),
        "model": tree([dirEntry("parts", "model/parts"), fileEntry("readme.md", "model/readme.md"), fileEntry("b.sysml", "model/b.sysml")]),
        "model/parts": tree([fileEntry("c.SysMl", "model/parts/c.SysMl")]),
      },
      reads: {
        "Model.SYSML": text("package Top;"),
        "model/b.sysml": text("package B;"),
        "model/parts/c.SysMl": text("package C;"),
      },
    });

    const result = await discoverOpenseFiles(files);

    expect(result.files).toEqual([
      { path: "Model.SYSML", source: "package Top;" },
      { path: "model/b.sysml", source: "package B;" },
      { path: "model/parts/c.SysMl", source: "package C;" },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(readCalls).toEqual(["Model.SYSML", "model/b.sysml", "model/parts/c.SysMl"]);
  });

  it("skips .git and node_modules directories at any depth", async () => {
    const { files, listCalls } = createFakeFiles({
      trees: {
        "": tree([dirEntry(".git", ".git"), dirEntry("node_modules", "node_modules"), dirEntry("src", "src")]),
        ".git": tree([fileEntry("hook.sysml", ".git/hook.sysml")]),
        "node_modules": tree([fileEntry("dep.sysml", "node_modules/dep.sysml")]),
        "src": tree([dirEntry("node_modules", "src/node_modules"), fileEntry("a.sysml", "src/a.sysml")]),
        "src/node_modules": tree([fileEntry("nested.sysml", "src/node_modules/nested.sysml")]),
      },
      reads: { "src/a.sysml": text("package A;") },
    });

    const result = await discoverOpenseFiles(files);

    expect(result.files).toEqual([{ path: "src/a.sysml", source: "package A;" }]);
    expect(result.diagnostics).toEqual([]);
    expect(listCalls).toEqual(["", "src"]);
  });

  it("does not count skipped .git/node_modules entries toward the entries cap", async () => {
    // MAX_DISCOVERY_ENTRIES skipped directories occupy the whole listing; a
    // real .sysml file then still fits under the cap because skips cost
    // nothing (the cap bounds work actually examined).
    const entries: OpenseDiscoveryTreeEntry[] = [];
    for (let i = 0; i < MAX_DISCOVERY_ENTRIES; i += 1) entries.push(dirEntry(".git", `g${String(i)}`));
    entries.push(fileEntry("model.sysml", "model.sysml"));

    const { files, readCalls } = createFakeFiles({
      trees: { "": tree(entries) },
      reads: { "model.sysml": text("package Model;") },
    });

    const result = await discoverOpenseFiles(files);

    expect(result.files).toEqual([{ path: "model.sysml", source: "package Model;" }]);
    expect(result.diagnostics).toEqual([]);
    expect(readCalls).toEqual(["model.sysml"]);
  });

  it("reports (and skips) files whose content was truncated by the workspace API", async () => {
    const { files } = createFakeFiles({
      trees: {
        "": tree([fileEntry("big.sysml", "big.sysml"), fileEntry("ok.sysml", "ok.sysml")]),
      },
      reads: {
        "big.sysml": { content: "partial prefix only", truncated: true, binary: false },
        "ok.sysml": text("package Ok;"),
      },
    });

    const result = await discoverOpenseFiles(files);

    expect(result.files).toEqual([{ path: "ok.sysml", source: "package Ok;" }]);
    expect(result.diagnostics).toEqual([
      { severity: "warning", path: "big.sysml", message: "File content truncated by the workspace API and skipped" },
    ]);
  });

  it("reports (and skips) binary files without passing them to loadModel", async () => {
    const { files } = createFakeFiles({
      trees: {
        "": tree([fileEntry("blob.sysml", "blob.sysml"), fileEntry("ok.sysml", "ok.sysml")]),
      },
      reads: {
        "blob.sysml": { content: "", truncated: false, binary: true },
        "ok.sysml": text("package Ok;"),
      },
    });

    const result = await discoverOpenseFiles(files);

    expect(result.files).toEqual([{ path: "ok.sysml", source: "package Ok;" }]);
    expect(result.diagnostics).toEqual([
      { severity: "warning", path: "blob.sysml", message: "Binary file skipped; not parsed as SysML source" },
    ]);
  });

  it("reports read failures as diagnostics instead of throwing, still collecting the rest", async () => {
    const { files } = createFakeFiles({
      trees: {
        "": tree([fileEntry("bad.sysml", "bad.sysml"), fileEntry("good.sysml", "good.sysml")]),
      },
      reads: {
        "bad.sysml": new Error("Permission denied"),
        "good.sysml": text("package Good;"),
      },
    });

    const result = await discoverOpenseFiles(files);

    expect(result.files).toEqual([{ path: "good.sysml", source: "package Good;" }]);
    expect(result.diagnostics).toEqual([
      { severity: "error", path: "bad.sysml", message: "Could not read file: Permission denied" },
    ]);
  });

  it("formats non-Error read rejections as diagnostics (still total)", async () => {
    const files: OpenseDiscoveryFiles = {
      listFiles: vi.fn<OpenseDiscoveryFiles["listFiles"]>(() => Promise.resolve(tree([fileEntry("a.sysml", "a.sysml")]))),
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberately models a non-Error rejection at an untyped adapter boundary
      readFile: vi.fn<OpenseDiscoveryFiles["readFile"]>(() => Promise.reject("denied")),
    };

    const result = await discoverOpenseFiles(files);

    expect(result.files).toEqual([]);
    expect(result.diagnostics).toEqual([
      { severity: "error", path: "a.sysml", message: "Could not read file: denied" },
    ]);
  });

  it("reports a truncated directory listing while still scanning the entries that were returned", async () => {
    const { files } = createFakeFiles({
      trees: {
        "": tree([dirEntry("many", "many"), fileEntry("a.sysml", "a.sysml")]),
        "many": tree([fileEntry("listed.sysml", "many/listed.sysml")], true),
      },
      reads: {
        "a.sysml": text("package A;"),
        "many/listed.sysml": text("package Listed;"),
      },
    });

    const result = await discoverOpenseFiles(files);

    expect(result.files).toEqual([
      { path: "a.sysml", source: "package A;" },
      { path: "many/listed.sysml", source: "package Listed;" },
    ]);
    expect(result.diagnostics).toEqual([
      { severity: "warning", path: "many", message: "Directory listing truncated by the workspace API; some entries were not scanned" },
    ]);
  });

  it("stops the whole walk at the entries cap and reports it", async () => {
    const entries: OpenseDiscoveryTreeEntry[] = [];
    for (let i = 0; i < MAX_DISCOVERY_ENTRIES; i += 1) entries.push(fileEntry(`f${String(i)}.txt`, `f${String(i)}.txt`));
    // The 2001st entry would be expanded if the cap did not stop the walk.
    entries.push(dirEntry("beyond", "beyond"));

    const { files, listCalls } = createFakeFiles({
      trees: { "": tree(entries) },
    });

    const result = await discoverOpenseFiles(files);

    expect(result.files).toEqual([]);
    expect(result.diagnostics).toEqual([
      { severity: "warning", message: `Discovery stopped after ${String(MAX_DISCOVERY_ENTRIES)} entries; remaining files were not scanned` },
    ]);
    expect(listCalls).toEqual([""]);
  });

  it("stops collecting at the files cap and reports it", async () => {
    const entries: OpenseDiscoveryTreeEntry[] = [];
    const reads: Record<string, OpenseDiscoveryFileContent> = {};
    for (let i = 0; i < MAX_DISCOVERY_FILES + 1; i += 1) {
      const path = `m${String(i).padStart(3, "0")}.sysml`;
      entries.push(fileEntry(path, path));
      reads[path] = text(`package M${String(i)};`);
    }

    const { files, readCalls } = createFakeFiles({ trees: { "": tree(entries) }, reads });

    const result = await discoverOpenseFiles(files);

    expect(result.files).toHaveLength(MAX_DISCOVERY_FILES);
    expect(readCalls).toHaveLength(MAX_DISCOVERY_FILES);
    expect(result.diagnostics).toEqual([
      { severity: "warning", message: `Discovery stopped after ${String(MAX_DISCOVERY_FILES)} .sysml files; remaining files were not scanned` },
    ]);
  });

  it("stops expanding at the depth cap, still collects files within it, and reports the cap once", async () => {
    const trees: Record<string, OpenseDiscoveryFileTree> = {
      "": tree([dirEntry("d1", "d1"), fileEntry("top.sysml", "top.sysml")]),
    };
    let dirPath = "d1";
    for (let level = 2; level <= MAX_DISCOVERY_DEPTH; level += 1) {
      const nextPath = `${dirPath}/d${String(level)}`;
      trees[dirPath] = tree([dirEntry(`d${String(level)}`, nextPath)]);
      dirPath = nextPath;
    }
    // Two branches one level past the cap hang here unexpanded; both would
    // emit a depth diagnostic without the dedup guard, so the fixture proves
    // the cap is reported exactly once (tagged with the first offender).
    trees[dirPath] = tree([
      dirEntry("gone", `${dirPath}/gone`),
      dirEntry("gone2", `${dirPath}/gone2`),
      fileEntry("in.sysml", `${dirPath}/in.sysml`),
    ]);
    trees[`${dirPath}/gone`] = tree([fileEntry("deep.sysml", `${dirPath}/gone/deep.sysml`)]);
    trees[`${dirPath}/gone2`] = tree([fileEntry("deep2.sysml", `${dirPath}/gone2/deep2.sysml`)]);

    const { files, listCalls, readCalls } = createFakeFiles({
      trees,
      reads: {
        "top.sysml": text("package Top;"),
        [`${dirPath}/in.sysml`]: text("package In;"),
      },
    });

    const result = await discoverOpenseFiles(files);

    expect(result.files).toEqual([
      { path: `${dirPath}/in.sysml`, source: "package In;" },
      { path: "top.sysml", source: "package Top;" },
    ]);
    expect(result.diagnostics).toEqual([
      {
        severity: "warning",
        path: `${dirPath}/gone`,
        message: `Discovery stopped expanding below ${String(MAX_DISCOVERY_DEPTH)} nested directories; deeper files were not scanned`,
      },
    ]);
    expect(listCalls).toHaveLength(MAX_DISCOVERY_DEPTH + 1); // root + d1..d12
    expect(listCalls).not.toContain(`${dirPath}/gone`);
    expect(listCalls).not.toContain(`${dirPath}/gone2`);
    expect(readCalls).toEqual(["top.sysml", `${dirPath}/in.sysml`]);
  });

  it("reads collected files with bounded concurrency (at most MAX_CONCURRENT_READS in flight)", async () => {
    const entries: OpenseDiscoveryTreeEntry[] = [];
    for (let i = 0; i < MAX_CONCURRENT_READS * 3; i += 1) {
      const path = `f${String(i).padStart(3, "0")}.sysml`;
      entries.push(fileEntry(path, path));
    }

    const readCalls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const files: OpenseDiscoveryFiles = {
      // Reads settle on a microtask, after every call of the current batch has
      // been issued synchronously, so maxInFlight measures true peak concurrency.
      readFile: vi.fn<OpenseDiscoveryFiles["readFile"]>((path: string) => {
        readCalls.push(path);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return Promise.resolve().then(() => {
          inFlight -= 1;
          return text(`package for ${path};`);
        });
      }),
      listFiles: vi.fn<OpenseDiscoveryFiles["listFiles"]>(() => Promise.resolve(tree(entries))),
    };

    const result = await discoverOpenseFiles(files);

    expect(result.files).toHaveLength(MAX_CONCURRENT_READS * 3);
    expect(result.diagnostics).toEqual([]);
    expect(readCalls).toHaveLength(MAX_CONCURRENT_READS * 3);
    expect(maxInFlight).toBe(MAX_CONCURRENT_READS);
  });

  it("ignores a hidden file named exactly `.sysml` (no character before the extension)", async () => {
    const { files, readCalls } = createFakeFiles({
      trees: {
        "": tree([fileEntry(".sysml", ".sysml"), fileEntry("model.sysml", "model.sysml")]),
      },
      reads: { "model.sysml": text("package Model;") },
    });

    const result = await discoverOpenseFiles(files);

    expect(result.files).toEqual([{ path: "model.sysml", source: "package Model;" }]);
    expect(result.diagnostics).toEqual([]);
    expect(readCalls).toEqual(["model.sysml"]);
  });

  it("guards against a directory appearing as its own descendant (cycle safety)", async () => {
    const { files, listCalls } = createFakeFiles({
      trees: {
        "": tree([dirEntry("a", "a")]),
        "a": tree([dirEntry("a", "a"), dirEntry("b", "a/b"), fileEntry("a.sysml", "a/a.sysml")]),
        "a/b": tree([dirEntry("a", "a"), fileEntry("b.sysml", "a/b/b.sysml")]),
      },
      reads: {
        "a/a.sysml": text("package A;"),
        "a/b/b.sysml": text("package B;"),
      },
    });

    const result = await discoverOpenseFiles(files);

    expect(result.files).toEqual([
      { path: "a/a.sysml", source: "package A;" },
      { path: "a/b/b.sysml", source: "package B;" },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(listCalls).toEqual(["", "a", "a/b"]);
  });

  it("is total: a failed root listing becomes a diagnostic, not a throw", async () => {
    const { files } = createFakeFiles({ listErrors: { "": "Permission denied" } });

    const result = await discoverOpenseFiles(files);

    expect(result.files).toEqual([]);
    expect(result.diagnostics).toEqual([
      { severity: "error", message: "Could not list the workspace root: Permission denied" },
    ]);
  });

  it("reports a failed directory listing and continues the rest of the walk", async () => {
    const { files, listCalls } = createFakeFiles({
      trees: {
        "": tree([dirEntry("ok", "ok"), dirEntry("bad", "bad")]),
        "ok": tree([fileEntry("a.sysml", "ok/a.sysml")]),
      },
      listErrors: { "bad": "No such directory" },
      reads: { "ok/a.sysml": text("package A;") },
    });

    const result = await discoverOpenseFiles(files);

    expect(result.files).toEqual([{ path: "ok/a.sysml", source: "package A;" }]);
    expect(result.diagnostics).toEqual([
      { severity: "error", path: "bad", message: "Could not list directory: No such directory" },
    ]);
    expect(listCalls).toEqual(["", "ok", "bad"]);
  });

  it("returns an empty result for an empty workspace", async () => {
    const { files } = createFakeFiles({ trees: { "": tree([]) } });

    const result = await discoverOpenseFiles(files);

    expect(result.files).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("finds nothing in a workspace without .sysml files", async () => {
    const { files, readCalls } = createFakeFiles({
      trees: {
        "": tree([fileEntry("readme.md", "readme.md"), dirEntry("docs", "docs")]),
        "docs": tree([fileEntry("guide.txt", "docs/guide.txt")]),
      },
    });

    const result = await discoverOpenseFiles(files);

    expect(result.files).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(readCalls).toEqual([]);
  });
});

// --- in-memory fake adapter -------------------------------------------------

interface FakeFilesOptions {
  trees?: Record<string, OpenseDiscoveryFileTree>;
  /** Directory paths whose listFiles rejects with the given error message. */
  listErrors?: Record<string, string>;
  /** File paths to result content/flags, or an Error to reject with. */
  reads?: Record<string, OpenseDiscoveryFileContent | Error>;
}

function createFakeFiles(options: FakeFilesOptions = {}): {
  files: OpenseDiscoveryFiles;
  listCalls: string[];
  readCalls: string[];
} {
  const listCalls: string[] = [];
  const readCalls: string[] = [];
  return {
    files: {
      listFiles: vi.fn<OpenseDiscoveryFiles["listFiles"]>((path: string) => {
        listCalls.push(path);
        const error = options.listErrors?.[path];
        if (error !== undefined) return Promise.reject(new Error(error));
        const tree = options.trees?.[path];
        if (tree === undefined) return Promise.reject(new Error(`Path does not exist: ${path}`));
        return Promise.resolve(tree);
      }),
      readFile: vi.fn<OpenseDiscoveryFiles["readFile"]>((path: string) => {
        readCalls.push(path);
        const read = options.reads?.[path];
        if (read === undefined) return Promise.reject(new Error(`Path does not exist: ${path}`));
        if (read instanceof Error) return Promise.reject(read);
        return Promise.resolve(read);
      }),
    },
    listCalls,
    readCalls,
  };
}

function dirEntry(name: string, path: string): OpenseDiscoveryTreeEntry {
  return { name, path, type: "directory" };
}

function fileEntry(name: string, path: string): OpenseDiscoveryTreeEntry {
  return { name, path, type: "file" };
}

function symlinkEntry(name: string, path: string): OpenseDiscoveryTreeEntry {
  return { name, path, type: "symlink" };
}

function tree(entries: OpenseDiscoveryTreeEntry[], truncated = false): OpenseDiscoveryFileTree {
  return { entries, truncated };
}

function text(content: string): OpenseDiscoveryFileContent {
  return { content, truncated: false, binary: false };
}