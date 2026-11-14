// ---------------------------------------------------------------------------
// Shared test fixtures for the OpenSE test suite (root-level module, excluded
// from the runtime build by scripts/build-plugin.mjs's skippedNames).
//
// One in-memory workspace-files fake serves both the discovery tests (which
// need call-order tracking) and the panel tests (which need a full
// `WorkspaceFiles` for the host context): the real `context.files` satisfies
// opense-discovery's minimal `OpenseDiscoveryFiles` adapter structurally, and
// so does this fake.
//
// Plan v4 §0.2 (fixture-builder consolidation): the per-test workspace-panel
// context builders that used to be duplicated in `opense-panel.test.ts`,
// `opense-panel-controller.test.ts`, `opense-panel-elements.test.ts` and
// `pi-web-plugin.test.ts` live here as `createPanelContext`, plus the
// activation fixture that captures the activation result (and therefore
// `dispose`). Later work items extend the same builder:
//  - W3 adds `createFakeCapabilityV1Files` (versioned files fake that records
//    the `AbortSignal` it receives).
//  - W4 adds `createFakeNavigation` (query record + `set` spy with the host's
//    runtime boolean result).
// ---------------------------------------------------------------------------

import { html, svg } from "lit";
import { vi, type Mock } from "vitest";
import type {
  ContributionQueryValue,
  FileContentResponse,
  FileTreeEntry,
  FileTreeResponse,
  PiWebPluginV5,
  PluginActivationContextV5,
  PluginActivationResultV5,
  PluginCatalog,
  PluginRuntimeContextV5,
  Workspace,
  WorkspaceFileRequestOptions,
  WorkspaceFiles,
  WorkspaceFilesCapabilityV1,
  WorkspaceFilesContextValue,
  WorkspacePanelContextV5,
  WorkspacePanelNavigationV1,
} from "@jmfederico/pi-web/plugin-api";
import type { OpenseWorkspaceHost } from "./opense-panel-controller.js";

/** One workspace's files adapter as discovery calls it (both request methods
 *  carry the optional v1 abort options; legacy hosts ignore the second
 *  argument, which discovery never passes unless the host is capability-v1). */
export type FakeListFiles = (path: string, options?: WorkspaceFileRequestOptions) => Promise<FileTreeResponse>;
export type FakeReadFile = (path: string, options?: WorkspaceFileRequestOptions) => Promise<FileContentResponse>;

export interface FakeFilesOptions {
  trees?: Record<string, FileTreeResponse>;
  /** Directory paths whose listFiles rejects with the given error message. */
  listErrors?: Record<string, string>;
  /** File paths to result content/flags, or an Error to reject with. */
  reads?: Record<string, FileContentResponse | Error>;
}

export interface FakeWorkspaceFiles {
  files: WorkspaceFiles;
  listFiles: Mock<FakeListFiles>;
  readFile: Mock<FakeReadFile>;
  /** Every listFiles path in call order (root first, then the walk order). */
  listCalls: string[];
  /** Every readFile path in call order. */
  readCalls: string[];
}

/** Versioned (capability-v1) variant: same in-memory behavior plus the v1
 *  fields, and the request options it receives recorded per call so tests can
 *  assert signal forwarding. */
export interface FakeCapabilityV1Files {
  files: WorkspaceFilesCapabilityV1;
  listFiles: Mock<FakeListFiles>;
  readFile: Mock<FakeReadFile>;
  listCalls: string[];
  readCalls: string[];
  /** The `signal` of every listFiles call, in call order. */
  listSignals: Array<AbortSignal | undefined>;
  /** The `signal` of every readFile call, in call order. */
  readSignals: Array<AbortSignal | undefined>;
}

interface FakeFilesCore {
  listFiles: Mock<FakeListFiles>;
  readFile: Mock<FakeReadFile>;
  listCalls: string[];
  readCalls: string[];
}

/**
 * In-memory workspace files adapter. Paths absent from `trees`/`reads`
 * reject with "Path does not exist", like the real workspace API.
 */
export function createFakeFiles(options: FakeFilesOptions = {}): FakeWorkspaceFiles {
  const core = createFakeFilesCore(options);
  return {
    files: {
      listFiles: core.listFiles,
      readFile: core.readFile,
      // Unused by the OpenSE plugin; present so the fake stays a full WorkspaceFiles.
      writeFile: () => Promise.reject(new Error("not implemented")),
      deleteFile: () => Promise.reject(new Error("not implemented")),
      moveFile: () => Promise.reject(new Error("not implemented")),
    },
    ...core,
  };
}

/**
 * Capability-v1 fake: identical read/list behavior, `capabilityVersion: 1`
 * plus the v1 surface, and per-call recording of the forwarded request
 * options (W3 signal-forwarding and abort assertions).
 */
export function createFakeCapabilityV1Files(options: FakeFilesOptions = {}): FakeCapabilityV1Files {
  const core = createFakeFilesCore(options);
  const listSignals: Array<AbortSignal | undefined> = [];
  const readSignals: Array<AbortSignal | undefined> = [];
  const listFiles = vi.fn<FakeListFiles>((path: string, requestOptions?: WorkspaceFileRequestOptions) => {
    listSignals.push(requestOptions?.signal);
    return core.listFiles(path);
  });
  const readFile = vi.fn<FakeReadFile>((path: string, requestOptions?: WorkspaceFileRequestOptions) => {
    readSignals.push(requestOptions?.signal);
    return core.readFile(path);
  });
  return {
    files: {
      capabilityVersion: 1,
      defaultUploadFolder: "uploads",
      maxInlinePreviewBytes: 1_000_000,
      listFiles,
      readFile,
      writeFile: () => Promise.reject(new Error("not implemented")),
      deleteFile: () => Promise.reject(new Error("not implemented")),
      moveFile: () => Promise.reject(new Error("not implemented")),
      previewUrl: () => "",
      downloadUrl: () => "",
      uploadFile: () => { throw new Error("not implemented"); },
    },
    listFiles,
    readFile,
    listCalls: core.listCalls,
    readCalls: core.readCalls,
    listSignals,
    readSignals,
  };
}

function createFakeFilesCore(options: FakeFilesOptions): FakeFilesCore {
  const listCalls: string[] = [];
  const readCalls: string[] = [];
  const listFiles = vi.fn<FakeListFiles>((path: string) => {
    listCalls.push(path);
    const error = options.listErrors?.[path];
    if (error !== undefined) return Promise.reject(new Error(error));
    const tree = options.trees?.[path];
    if (tree === undefined) return Promise.reject(new Error(`Path does not exist: ${path}`));
    return Promise.resolve(tree);
  });
  const readFile = vi.fn<FakeReadFile>((path: string) => {
    readCalls.push(path);
    const read = options.reads?.[path];
    if (read === undefined) return Promise.reject(new Error(`Path does not exist: ${path}`));
    if (read instanceof Error) return Promise.reject(read);
    return Promise.resolve(read);
  });
  return { listFiles, readFile, listCalls, readCalls };
}

export function dirEntry(name: string, path: string): FileTreeEntry {
  return { name, path, type: "directory" };
}

export function fileEntry(name: string, path: string): FileTreeEntry {
  return { name, path, type: "file" };
}

export function symlinkEntry(name: string, path: string): FileTreeEntry {
  return { name, path, type: "symlink" };
}

export function tree(entries: FileTreeEntry[], truncated = false): FileTreeResponse {
  return { path: "", entries, scannedAt: "", truncated };
}

export function text(content: string): FileContentResponse {
  return { path: "", content, truncated: false, binary: false, encoding: "utf8", size: 0, modifiedAt: "" };
}

/** The workspace every panel-context fixture defaults to. */
export const testWorkspace: Workspace = {
  id: "workspace-1",
  projectId: "project-1",
  path: "/repo",
  label: "main",
  isMain: true,
};

/** Discovery-context fixture (v5 migration): a stub `PluginCatalog` for the
 *  `catalog` member the v5 callback contexts require. OpenSE's callbacks
 *  ignore it, so only the captured `machineId` is meaningful (matches the
 *  fixture machine). The `list` methods resolve empty results (inert,
 *  realistic "no data" that avoids unhandled-rejection pitfalls), while the
 *  `get` methods reject — so an accidental future read either sees "no
 *  data" or fails loudly. */
export function createFakeCatalog(machineId = "local"): PluginCatalog {
  const notImplemented = () => Promise.reject(new Error("not implemented"));
  return {
    machineId,
    version: 1,
    projects: { list: () => Promise.resolve([]), get: () => notImplemented() },
    workspaces: { list: () => Promise.resolve([]), get: () => notImplemented() },
    sessions: { list: () => Promise.resolve([]), get: () => notImplemented() },
  };
}

export interface PanelContextOptions {
  workspace?: Workspace;
  machineId?: string;
  files?: WorkspaceFilesContextValue;
  insertText?: (text: string) => void;
  navigation?: WorkspacePanelNavigationV1;
}

export interface PanelContextFixture {
  context: WorkspacePanelContextV5;
  /** Render-notification spy (the context host the controller routes through). */
  requestRender: Mock<() => void>;
}

/**
 * One `WorkspacePanelContext` fixture (plan v4 §0.2), shared by the panel,
 * controller, element and entry tests. Typed as the v5 context so it can be
 * passed to the v5 panel callbacks (`visible`/`render`/`onInvalidate`); the
 * only v5 addition is the discovery `catalog` stub, which the plugin
 * ignores. Defaults: `testWorkspace`, machine
 * "local", an empty in-memory files fake, a no-op prompt editor, and no
 * `navigation` (legacy host). Callers pass their own `files` fake,
 * workspace, `insertText` spy and/or `navigation` fake as needed.
 */
export function createPanelContext(options: PanelContextOptions = {}): PanelContextFixture {
  const workspace = options.workspace ?? testWorkspace;
  const machineId = options.machineId ?? "local";
  const requestRender = vi.fn<() => void>();
  const insertText = options.insertText ?? (() => undefined);
  const context: WorkspacePanelContextV5 = {
    machine: { id: machineId, name: machineId, kind: machineId === "local" ? "local" : "remote" },
    workspace,
    state: { selectedWorkspace: workspace, workspaceTool: "opense:workspace.opense", mainView: "workspace" },
    files: options.files ?? createFakeFiles().files,
    host: { requestRender },
    catalog: createFakeCatalog(machineId),
    navigate: () => Promise.resolve(),
    prompt: { insertText, getText: () => "", getSelection: () => null },
    terminal: { open: () => undefined, runCommand: () => Promise.reject(new Error("not implemented")) },
    ...(options.navigation === undefined ? {} : { navigation: options.navigation }),
  };
  return { context, requestRender };
}

/** The controller's mutable connection-flag host (`OpenseWorkspaceHost`). */
export function createFakeHost(): OpenseWorkspaceHost {
  return { isConnected: false };
}

export interface FakeNavigationOptions {
  /** Initial query state (`context.navigation.query`). */
  query?: Record<string, string | readonly string[]>;
  /** Runtime result of `set`; hosts return whether the write applied. */
  applied?: boolean;
}

export interface FakeNavigation {
  navigation: WorkspacePanelNavigationV1;
  /** Spy with the host's runtime boolean result (the API types `set` as void). */
  set: Mock<FakeNavigationSet>;
  query: Record<string, string | readonly string[]>;
}

type FakeNavigationSet = (
  key: string,
  value: ContributionQueryValue | undefined | null,
  options?: { replace?: boolean | undefined },
) => boolean;

/**
 * `WorkspacePanelNavigationV1` fake (W4): a mutable query record plus a `set`
 * spy. The host's `set` is typed `void` but returns whether the write applied
 * at runtime; the fake returns the same boolean and mirrors applied writes
 * into `query` so assertions can read either.
 */
export function createFakeNavigation(options: FakeNavigationOptions = {}): FakeNavigation {
  const query = options.query ?? {};
  const set = vi.fn<FakeNavigationSet>((key, value) => {
    if (options.applied === false) return false;
    if (value === undefined || value === null) delete query[key];
    else query[key] = Array.isArray(value) ? value.map(String) : String(value);
    return true;
  });
  const navigation: WorkspacePanelNavigationV1 = {
    version: 1,
    contributionId: "opense:workspace.opense",
    query,
    set,
  };
  return { navigation, set, query };
}

/**
 * Activation fixture (plan v4 §0.2): runs a plugin's `activate` with the
 * context the host supplies and returns the whole activation result, so entry
 * tests can assert `dispose` as well as `contributions`. Activation must be
 * synchronous (the OpenSE entry is).
 *
 * `pluginId` is the manifest source identity and `runtimePluginId` the
 * host-unique identity (they are usually equal, but the host may suffix the
 * runtime id on federated machines). `plugin.name` is only the display label
 * (OpenSE), so it is deliberately not used here; a fixture reused for another
 * bundled plugin must pass that plugin's ids explicitly.
 */
export function activatePlugin(
  plugin: PiWebPluginV5,
  runtimePluginId = "opense",
  pluginId = "opense",
): PluginActivationResultV5 {
  const context: PluginActivationContextV5 = {
    apiVersion: 5,
    pluginId,
    runtimePluginId,
    html,
    svg,
    signal: new AbortController().signal,
    lifetimeSignal: new AbortController().signal,
  };
  const result = plugin.activate(context);
  if (result instanceof Promise) throw new Error("Expected synchronous plugin activation");
  return result;
}
