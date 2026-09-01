// ---------------------------------------------------------------------------
// Bounded recursive *.sysml workspace discovery.
//
// Walks the active workspace through an injected `files` adapter that carries
// only the two methods discovery needs (`listFiles` + `readFile`), shaped as
// structural subsets of the host `context.files` methods. This mirrors the
// workspace-tasks file-reader idiom: the actual `WorkspaceFiles` object the
// plugin receives satisfies the interface without any import of the host API,
// and tests inject an in-memory fake. No fetch/URL code lives here — the
// adapter is the only boundary.
//
// Policy decisions (matching the plugin plan):
//
// - Hard caps bound the walk on large workspaces: entries visited (across all
//   listFiles responses), .sysml files admitted for reading, and directory-
//   listing depth. When a cap fires the walk stops expanding and a diagnostic
//   reports it; caps never silently truncate.
// - Response flags are never dropped silently: a directory listing that the
//   workspace API truncated, and a file whose content was truncated or is
//   binary, each become a diagnostic. A binary or truncated file is never
//   passed to loadModel as source.
// - Discovery is total: listFiles/readFile rejections become diagnostics, so
//   this module never throws on adapter failures.
// - Symlink entries are neither expanded nor collected. A browser walk has no
//   server-side symlink-escape protection, so following `symlink` entries is
//   deliberately out of scope (the plan documents this loss of symlink
//   semantics).
// - Determinism: traversal processes listFiles responses in their returned
//   order (the workspace API already sorts entries), a visited-directory set
//   guards against a directory appearing as its own descendant, and the
//   collected files are sorted by path before returning so `loadModel` gets a
//   deterministic order.
// - Reads are bounded-concurrent (plan risk 5): readFile calls are issued in
//   batches of up to MAX_CONCURRENT_READS, so a wide workspace never pays a
//   serial HTTP round-trip per file. listFiles walks stay sequential, and
//   read outcomes commit in encounter order, so the output stays
//   deterministic.
// - Depth semantics: the root listing is depth 0; the walk issues listings
//   for directories at depth 1..MAX_DISCOVERY_DEPTH. Directory entries beyond
//   the cap are not expanded and are reported once, tagged with the first
//   offending directory's path.
// ---------------------------------------------------------------------------

import type { SourceFile } from "./vendor/sysml-parser.bundle.js";
import type { WorkspaceDiagnostic } from "./opense-contract.js";
import { formatUnknownError } from "./opense-shared.js";

/** Path of the workspace root, matching `context.files.listFiles("")`. */
const WORKSPACE_ROOT = "";

/** Hard cap: total tree entries examined across every listFiles response. */
export const MAX_DISCOVERY_ENTRIES = 2000;
/** Hard cap: .sysml files admitted for reading (collected and parsed later). */
export const MAX_DISCOVERY_FILES = 500;
/** Hard cap: deepest directory the walk expands (the root listing is depth 0). */
export const MAX_DISCOVERY_DEPTH = 12;
/** Max readFile calls issued concurrently (plan risk 5: batch reads ~8 at a time). */
export const MAX_CONCURRENT_READS = 8;

/** Case-insensitive file-extension match; at least one character before it. */
const SYSML_EXTENSION = ".sysml";

/** Directories never expanded, at any depth (matched by exact leaf name). */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules"]);

/** Narrow file-access surface discovery needs, structurally satisfied by the
 *  host `context.files` (`WorkspaceFiles`): its `listFiles`/`readFile` return
 *  supersets of the response types below, so no host import is required. */
export interface OpenseDiscoveryFiles {
  listFiles(relativePath: string): Promise<OpenseDiscoveryFileTree>;
  readFile(relativePath: string): Promise<OpenseDiscoveryFileContent>;
}

/** Minimal `FileTreeResponse` subset: entry list plus the truncation flag. */
export interface OpenseDiscoveryFileTree {
  entries: OpenseDiscoveryTreeEntry[];
  truncated: boolean;
}

/** Minimal `FileTreeEntry` subset — the three fields the walk branches on. */
export interface OpenseDiscoveryTreeEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
}

/** Minimal `FileContentResponse` subset: source plus the two flags. */
export interface OpenseDiscoveryFileContent {
  content: string;
  truncated: boolean;
  binary: boolean;
}

/**
 * Discovery diagnostics reuse the plugin's report diagnostic shape, so the
 * panel can render walk issues exactly like parser diagnostics.
 */
export type DiscoveryDiagnostic = WorkspaceDiagnostic;

/** Outcome of one workspace discovery, ready for `loadModel`. */
export interface OpenseDiscoveryResult {
  files: SourceFile[];
  diagnostics: DiscoveryDiagnostic[];
}

const ENTRIES_CAP_MESSAGE = `Discovery stopped after ${String(MAX_DISCOVERY_ENTRIES)} entries; remaining files were not scanned`;
const FILES_CAP_MESSAGE = `Discovery stopped after ${String(MAX_DISCOVERY_FILES)} .sysml files; remaining files were not scanned`;
const DEPTH_CAP_MESSAGE = `Discovery stopped expanding below ${String(MAX_DISCOVERY_DEPTH)} nested directories; deeper files were not scanned`;
const TREE_TRUNCATED_MESSAGE = "Directory listing truncated by the workspace API; some entries were not scanned";
const BINARY_FILE_MESSAGE = "Binary file skipped; not parsed as SysML source";
const TRUNCATED_FILE_MESSAGE = "File content truncated by the workspace API and skipped";

/** One directory queued for expansion: its path and listing depth. */
interface PendingDirectory {
  path: string;
  depth: number;
}

/**
 * Discover every readable `.sysml` file under the workspace root through the
 * injected `files` adapter. Returns the files sorted by path (deterministic
 * `loadModel` input) plus diagnostics for skipped/inaccessible content; never
 * throws (adapter failures are diagnosed, not raised).
 */
export async function discoverOpenseFiles(files: OpenseDiscoveryFiles): Promise<OpenseDiscoveryResult> {
  const collected: SourceFile[] = [];
  const diagnostics: DiscoveryDiagnostic[] = [];
  const visitedDirectories = new Set<string>([WORKSPACE_ROOT]);

  let entriesVisited = 0;
  let filesAdmitted = 0;
  let depthCapReported = false;
  let walkStopped = false;

  const pendingFileReads: string[] = [];
  const pending: PendingDirectory[] = [{ path: WORKSPACE_ROOT, depth: 0 }];
  let nextIndex = 0;
  while (nextIndex < pending.length && !walkStopped) {
    const directory = pending[nextIndex];
    if (directory === undefined) break;
    nextIndex += 1;

    let tree: OpenseDiscoveryFileTree;
    try {
      tree = await files.listFiles(directory.path);
    } catch (error) {
      diagnostics.push(listErrorDiagnostic(directory.path, error));
      continue;
    }

    for (const entry of tree.entries) {
      // Skipped directories cost nothing, so they never count toward the
      // entries cap — the cap bounds work actually examined, not entries
      // short-circuited before examination.
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;

      entriesVisited += 1;
      if (entriesVisited > MAX_DISCOVERY_ENTRIES) {
        diagnostics.push({ severity: "warning", message: ENTRIES_CAP_MESSAGE });
        walkStopped = true;
        break;
      }

      if (entry.type === "directory") {
        if (directory.depth + 1 > MAX_DISCOVERY_DEPTH) {
          if (!depthCapReported) {
            depthCapReported = true;
            // Only the first offender is tagged; later ones are deduped.
            diagnostics.push({ severity: "warning", path: entry.path, message: DEPTH_CAP_MESSAGE });
          }
          continue;
        }
        // Cycle guard: a directory appearing as its own descendant (for
        // example a self-referential entry) re-enters the set and is skipped.
        if (visitedDirectories.has(entry.path)) continue;
        visitedDirectories.add(entry.path);
        pending.push({ path: entry.path, depth: directory.depth + 1 });
        continue;
      }

      if (entry.type === "file" && isSysmlFileName(entry.name)) {
        // Admitted (not collected) count: admission happens before the read,
        // so the cap still bounds readFile calls when reads run concurrently
        // and read outcomes (binary/truncated/failure) are not yet known.
        if (filesAdmitted >= MAX_DISCOVERY_FILES) {
          diagnostics.push({ severity: "warning", message: FILES_CAP_MESSAGE });
          walkStopped = true;
          break;
        }
        filesAdmitted += 1;
        pendingFileReads.push(entry.path);
        if (pendingFileReads.length >= MAX_CONCURRENT_READS) {
          await flushPendingReads(pendingFileReads, collected, diagnostics, files);
        }
      }
    }

    if (tree.truncated) {
      diagnostics.push({ severity: "warning", path: directory.path, message: TREE_TRUNCATED_MESSAGE });
    }
  }

  // The final partial batch (and any reads admitted before another cap fired).
  await flushPendingReads(pendingFileReads, collected, diagnostics, files);

  collected.sort(compareByPath);
  return { files: collected, diagnostics };
}

/**
 * Issue every pending path's readFile call (up to MAX_CONCURRENT_READS at
 * once — the batch size is the concurrency bound), then commit the outcomes
 * in encounter order. Rejections are handled per-read via allSettled, so one
 * failing read never loses the rest of the batch.
 */
async function flushPendingReads(
  pending: string[],
  collected: SourceFile[],
  diagnostics: DiscoveryDiagnostic[],
  files: OpenseDiscoveryFiles,
): Promise<void> {
  const paths = pending.splice(0);
  if (paths.length === 0) return;
  const settled = await Promise.allSettled(paths.map((path) => files.readFile(path)));
  // Zip outcomes with their paths so commit order is encounter order.
  const outcomes = paths.map((path, index) => ({ path, result: settled[index] }));
  for (const { path, result } of outcomes) {
    if (result === undefined) continue;
    applyReadResult(path, result, collected, diagnostics);
  }
}

/** Commit one read outcome: diagnostic on rejection/binary/truncated, else collect. */
function applyReadResult(
  path: string,
  settled: PromiseSettledResult<OpenseDiscoveryFileContent>,
  collected: SourceFile[],
  diagnostics: DiscoveryDiagnostic[],
): void {
  if (settled.status === "rejected") {
    diagnostics.push({
      severity: "error",
      path,
      message: `Could not read file: ${formatUnknownError(settled.reason)}`,
    });
    return;
  }

  // A binary or truncated file must not reach loadModel: report and skip.
  if (settled.value.binary) {
    diagnostics.push({ severity: "warning", path, message: BINARY_FILE_MESSAGE });
    return;
  }
  if (settled.value.truncated) {
    diagnostics.push({ severity: "warning", path, message: TRUNCATED_FILE_MESSAGE });
    return;
  }
  collected.push({ path, source: settled.value.content });
}

function listErrorDiagnostic(path: string, error: unknown): DiscoveryDiagnostic {
  return path === WORKSPACE_ROOT
    ? { severity: "error", message: `Could not list the workspace root: ${formatUnknownError(error)}` }
    : { severity: "error", path, message: `Could not list directory: ${formatUnknownError(error)}` };
}

function isSysmlFileName(name: string): boolean {
  return name.length > SYSML_EXTENSION.length && name.toLowerCase().endsWith(SYSML_EXTENSION);
}

/** Code-unit string comparison — fully environment-independent ordering. */
function compareByPath(a: SourceFile, b: SourceFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}