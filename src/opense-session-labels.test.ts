// @vitest-environment node
//
// Unit tests for the browser session-list row label (plan-v5 §2.E E4,
// mirroring opendoor's doorstop-session-labels.test.ts): the contribution
// shape, the pure/synchronous/tolerant `items()` behavior for BOTH ops, the
// label text, the exact reopen destination + click navigation (the W4a
// `element` deep-link key), and the session lifecycle buttons —
// event-handler-only calls, absence tolerance, the pure render-side gate,
// the archive busy-refusal (the prove-not-busy gate: busy rows and unreadable
// snapshots refuse; idle AND not-hosted rows archive), and the
// fire-and-forget catch.

import { describe, expect, it, vi, type Mock } from "vitest";
import type { TemplateResult } from "lit";
import type {
  PluginCatalog,
  PluginSessionLifecycle,
  PluginSessionSnapshot,
  SessionLabelContextV5,
  SessionUiMetadata,
} from "@jmfederico/pi-web/plugin-api";
import {
  buildSessionLifecycleHandlers,
  createOpenseSessionLabel,
  openseReopenDestination,
  openseSessionSelection,
  sessionLabelItems,
  sessionLifecycleActions,
} from "./opense-session-labels.js";
import { createFakeCatalog, createFakeFiles, testWorkspace } from "./test-support.js";

const PANEL_ID = "opense:workspace.opense";
const SELECTION = { projectId: "project-1", workspaceId: "workspace-1", sessionId: "session-1" };

interface LabelContextOptions {
  navigate?: Mock;
  archived?: boolean;
  /** When true, the row snapshot still waits for session creation (archive
   *  must refuse it before touching the catalog). */
  pending?: boolean;
  sessions?: PluginSessionLifecycle;
  /** When set, the context carries a catalog whose `sessions.get` resolves the
   *  given runtime (the field the archive handler's busy gate reads). */
  runtime?: PluginSessionSnapshot["runtime"];
}

function contextWith(metadata: SessionUiMetadata | undefined, options: LabelContextOptions = {}): SessionLabelContextV5 {
  const sessions = options.sessions;
  return {
    machine: { id: "local", name: "local", kind: "local" },
    // v5 context surface: the fake catalog is inert unless a test supplies a
    // runtime — the label reads no catalog data at render time.
    catalog: options.runtime === undefined ? createFakeCatalog() : catalogWithRuntime(options.runtime),
    workspace: testWorkspace,
    files: createFakeFiles().files,
    host: { requestRender: vi.fn() },
    session: {
      id: SELECTION.sessionId,
      cwd: testWorkspace.path,
      archived: options.archived ?? false,
      pending: options.pending ?? false,
      // exactOptionalPropertyTypes: only attach the field when present.
      ...(metadata === undefined ? {} : { metadata }),
    },
    navigate: options.navigate ?? vi.fn(),
    // The lifecycle surface is optional: only present when a test supplies
    // one, exactly like an older host that omits it.
    ...(sessions === undefined ? {} : { sessions }),
  };
}

/** A catalog whose `sessions.get` resolves one snapshot with the given
 *  runtime/lifecycle bits (everything else is irrelevant to the label). */
function catalogWithRuntime(runtime: PluginSessionSnapshot["runtime"]): PluginCatalog {
  const base = createFakeCatalog();
  return {
    ...base,
    sessions: {
      ...base.sessions,
      get: () =>
        Promise.resolve({
          id: SELECTION.sessionId,
          cwd: testWorkspace.path,
          archived: false,
          created: null,
          modified: null,
          archivedAt: null,
          pinned: false,
          runtime,
        }),
    },
  };
}

interface FakeSessions {
  sessions: PluginSessionLifecycle;
  get: Mock<PluginSessionLifecycle["get"]>;
  pin: Mock<PluginSessionLifecycle["pin"]>;
  unpin: Mock<PluginSessionLifecycle["unpin"]>;
  archive: Mock<PluginSessionLifecycle["archive"]>;
  restore: Mock<PluginSessionLifecycle["restore"]>;
  delete: Mock<PluginSessionLifecycle["delete"]>;
}

/** A lifecycle surface whose `get` reports the given live pin state; every op
 * resolves (or rejects when `hook.reject` names it) and records its calls. */
function fakeSessions(hook: { pinned?: boolean; reject?: "get" | "archive" | "restore" } = {}): FakeSessions {
  const reject = hook.reject;
  const get = vi.fn<PluginSessionLifecycle["get"]>(() =>
    reject === "get"
      ? Promise.reject(new Error("lifecycle get failed"))
      : Promise.resolve({ sessionId: SELECTION.sessionId, pinned: hook.pinned ?? false, archived: false }),
  );
  const pin = vi.fn<PluginSessionLifecycle["pin"]>(() => Promise.resolve());
  const unpin = vi.fn<PluginSessionLifecycle["unpin"]>(() => Promise.resolve());
  const archiveOp = vi.fn<PluginSessionLifecycle["archive"]>(() =>
    reject === "archive" ? Promise.reject(new Error("lifecycle archive failed")) : Promise.resolve(),
  );
  const restoreOp = vi.fn<PluginSessionLifecycle["restore"]>(() =>
    reject === "restore" ? Promise.reject(new Error("lifecycle restore failed")) : Promise.resolve(),
  );
  const del = vi.fn<PluginSessionLifecycle["delete"]>(() => Promise.resolve());
  return {
    sessions: { version: 1, machineId: "local", get, pin, unpin, archive: archiveOp, restore: restoreOp, delete: del },
    get,
    pin,
    unpin,
    archive: archiveOp,
    restore: restoreOp,
    delete: del,
  };
}

// --- render inspection helpers -------------------------------------------------
// The suite is node-env: lifecycle behavior is asserted through the exported
// handlers and the template VALUES lit produces (no DOM needed).

function isTemplateResult(value: unknown): value is TemplateResult {
  return typeof value === "object" && value !== null && "strings" in value && "values" in value;
}

function allTemplates(template: TemplateResult): TemplateResult[] {
  return [template, ...template.values.flatMap((value) => nestedTemplates(value))];
}

function nestedTemplates(value: unknown): TemplateResult[] {
  if (Array.isArray(value)) return value.flatMap((entry) => nestedTemplates(entry));
  return isTemplateResult(value) ? allTemplates(value) : [];
}

function renderedLabel(context: SessionLabelContextV5): TemplateResult {
  const item = sessionLabelItems(context, PANEL_ID)[0];
  if (item?.type !== "render") throw new Error("expected a render item");
  return item.render();
}

/** Every literal string a rendered label carries, across nested templates. */
function stringValues(template: TemplateResult): string[] {
  return allTemplates(template).flatMap((entry) => entry.values.filter((value): value is string => typeof value === "string"));
}

/** The literal markup (template strings only) a rendered label carries. */
function markup(template: TemplateResult): string {
  return allTemplates(template)
    .map((entry) => entry.strings.join(""))
    .join("");
}

/** The `opense-session-label-<action>` class of every rendered button. */
function buttonClasses(template: TemplateResult): string[] {
  return stringValues(template).filter((value) => value.startsWith("opense-session-label-"));
}

/** The click handler carried by the button for one lifecycle action. */
function clickHandler(
  template: TemplateResult,
  action: "pin" | "archive" | "restore",
): (event: Event) => void {
  const button = allTemplates(template).find((entry) => entry.values.includes(`opense-session-label-${action}`));
  if (button === undefined) throw new Error(`no rendered button for ${action}`);
  // The button template carries exactly one function value (@click); a second
  // listener added to the button would need an index-based lookup here.
  const handler = button.values.find((value): value is (event: Event) => void => typeof value === "function");
  if (handler === undefined) throw new Error(`no click handler for ${action}`);
  return handler;
}

function fakeEvent(): Event {
  return { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as Event;
}

function payload(op: "investigate" | "task"): SessionUiMetadata {
  return { opense: { schema: 1, op, elements: ["Pkg::Wheel"] } };
}

const flushMicro = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Drain the promise queues the fire-and-forget lifecycle chains use. */
async function flushAll(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await flushMicro();
}

describe("createOpenseSessionLabel", () => {
  it("contributes one synchronous items() callback under the element id/order", () => {
    const label = createOpenseSessionLabel("opense");
    expect(label.id).toBe("opense.element");
    expect(label.order).toBe(10);
    expect(typeof label.items).toBe("function");
    // No `visible` gate: absent metadata already yields no items.
    expect(label.visible).toBeUndefined();
  });
});

describe("sessionLabelItems", () => {
  it("renders nothing without metadata, for foreign namespaces, and for junk/future schemas", () => {
    expect(sessionLabelItems(contextWith(undefined), PANEL_ID)).toEqual([]);
    expect(sessionLabelItems(contextWith({ other: { schema: 1, op: "investigate", elements: ["Pkg::Wheel"] } }), PANEL_ID)).toEqual([]);
    expect(sessionLabelItems(contextWith({ opense: { schema: 2, op: "investigate", elements: ["Pkg::Wheel"] } }), PANEL_ID)).toEqual([]);
    expect(sessionLabelItems(contextWith({ opense: { schema: 1, op: "investigate", elements: [] } }), PANEL_ID)).toEqual([]);
    expect(sessionLabelItems(contextWith({ opense: "junk" as never }), PANEL_ID)).toEqual([]);
  });

  it("renders ONE render item whose text reflects the op, for both ops", () => {
    for (const [op, text] of [
      ["investigate", "OpenSE investigate"],
      ["task", "OpenSE task"],
    ] as const) {
      const items = sessionLabelItems(contextWith(payload(op)), PANEL_ID);
      expect(items).toHaveLength(1);
      const item = items[0];
      if (item?.type !== "render") throw new Error("expected a render item");
      const template = item.render();
      expect(template.values).toContain(text);
      expect(template.values).toContain("Reopen Pkg::Wheel in OpenSE");
    }
  });

  it("is side-effect-free: items() never navigates and returns fresh arrays", () => {
    const navigate = vi.fn();
    const context = contextWith(payload("investigate"), { navigate });
    const first = sessionLabelItems(context, PANEL_ID);
    const second = sessionLabelItems(context, PANEL_ID);
    expect(navigate).not.toHaveBeenCalled();
    expect(first).not.toBe(second);
    expect(first[0]?.type).toBe("render");
  });

  it("navigates to the OpenSE panel on the row's workspace with the element query when clicked", () => {
    const navigate = vi.fn();
    const context = contextWith(payload("task"), { navigate });
    const items = sessionLabelItems(context, PANEL_ID);
    const item = items[0];
    if (item?.type !== "render") throw new Error("expected a render item");
    const handler = item
      .render()
      .values.find((value): value is (event: Event) => void => typeof value === "function");
    if (handler === undefined) throw new Error("expected a click handler");

    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as Event;
    handler(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    // The W4a `element` deep-link key: the same key the chat message action
    // navigates with, resolved by the controller's C3 restore step.
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({
      machineId: "local",
      projectId: "project-1",
      workspaceId: "workspace-1",
      view: "workspace",
      tool: PANEL_ID,
      query: { element: "Pkg::Wheel" },
    });
  });
});

describe("session row lifecycle (plan-v5 §2.E E4)", () => {
  it("builds the machine-local selection from the row's workspace and session", () => {
    expect(openseSessionSelection(contextWith(payload("investigate")))).toEqual(SELECTION);
  });

  it("stays side-effect-free with a lifecycle surface present: neither items() nor render() calls a sessions method", () => {
    const fake = fakeSessions();
    const context = contextWith(payload("investigate"), { sessions: fake.sessions, runtime: "idle" });
    const items = sessionLabelItems(context, PANEL_ID);
    expect(items).toHaveLength(1);
    renderedLabel(context);
    for (const spy of [fake.get, fake.pin, fake.unpin, fake.archive, fake.restore, fake.delete]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("renders only the reopen link when the host omits sessions (older host)", () => {
    const context = contextWith(payload("investigate"));
    const template = renderedLabel(context);
    expect(sessionLifecycleActions(context)).toEqual([]);
    expect(markup(template)).toContain("<a");
    expect(markup(template)).not.toContain("<button");
    expect(buttonClasses(template)).toEqual([]);
  });

  it("offers pin + archive on active rows and pin + restore on archived rows, never archive and restore together", () => {
    const sessions = fakeSessions().sessions;
    const active = contextWith(payload("investigate"), { sessions });
    expect(sessionLifecycleActions(active)).toEqual(["pin", "archive"]);
    const activeTemplate = renderedLabel(active);
    expect(buttonClasses(activeTemplate)).toEqual(["opense-session-label-pin", "opense-session-label-archive"]);
    expect(markup(activeTemplate).match(/<button/gu) ?? []).toHaveLength(2);
    expect(markup(activeTemplate).match(/type="button"/gu) ?? []).toHaveLength(2);
    const activeStrings = stringValues(activeTemplate);
    expect(activeStrings).toContain("Pin");
    expect(activeStrings).toContain("Archive");
    expect(activeStrings).toContain("Toggle pin (protects this OpenSE session from cleanup)");

    const archived = contextWith(payload("task"), { sessions, archived: true });
    expect(sessionLifecycleActions(archived)).toEqual(["pin", "restore"]);
    const archivedTemplate = renderedLabel(archived);
    expect(buttonClasses(archivedTemplate)).toEqual(["opense-session-label-pin", "opense-session-label-restore"]);
    expect(markup(archivedTemplate).match(/<button/gu) ?? []).toHaveLength(2);
    expect(stringValues(archivedTemplate)).toContain("Restore");
  });

  it("toggles the pin from the live state: unpinned rows pin, pinned rows unpin", async () => {
    const unpinned = fakeSessions({ pinned: false });
    const activeContext = contextWith(payload("investigate"), { sessions: unpinned.sessions });
    clickHandler(renderedLabel(activeContext), "pin")(fakeEvent());
    await flushMicro();
    expect(unpinned.get).toHaveBeenCalledWith(SELECTION);
    expect(unpinned.pin).toHaveBeenCalledWith(SELECTION);
    expect(unpinned.unpin).not.toHaveBeenCalled();

    const pinned = fakeSessions({ pinned: true });
    const archivedContext = contextWith(payload("investigate"), { sessions: pinned.sessions, archived: true });
    clickHandler(renderedLabel(archivedContext), "pin")(fakeEvent());
    await flushMicro();
    expect(pinned.get).toHaveBeenCalledWith(SELECTION);
    expect(pinned.unpin).toHaveBeenCalledWith(SELECTION);
    expect(pinned.pin).not.toHaveBeenCalled();
  });

  it("refuses to archive a busy or pending session (only a proven-busy row refuses)", async () => {
    const fake = fakeSessions();
    const busyContext = contextWith(payload("task"), { sessions: fake.sessions, runtime: "busy" });
    const handler = clickHandler(renderedLabel(busyContext), "archive");
    expect(() => {
      handler(fakeEvent());
    }).not.toThrow();
    await flushMicro();
    // A dispatched investigator still working is not complete — the host's
    // own lifecycle capability refuses only `busy` too.
    expect(fake.archive).not.toHaveBeenCalled();

    // A row still waiting for session creation is refused before the catalog
    // read, whatever the snapshot would say.
    const pending = fakeSessions();
    const pendingContext = contextWith(payload("investigate"), { sessions: pending.sessions, runtime: "idle", pending: true });
    clickHandler(renderedLabel(pendingContext), "archive")(fakeEvent());
    await flushMicro();
    expect(pending.archive).not.toHaveBeenCalled();
  });

  it("archives a not-hosted session with the exact selection (routine post-restart, provably not running)", async () => {
    // After a session-daemon restart every row reads "not-hosted" until it
    // is reopened (piSessionService.ts maps `runtime: undefined` to
    // "not-hosted"); that state is provably not running, so it archives like
    // idle — the host's own lifecycle capability and the opendoor template
    // refuse only `busy` too.
    const fake = fakeSessions();
    const context = contextWith(payload("task"), { sessions: fake.sessions, runtime: "not-hosted" });
    clickHandler(renderedLabel(context), "archive")(fakeEvent());
    await flushMicro();
    expect(fake.archive).toHaveBeenCalledWith(SELECTION);
  });

  it("archives an idle session with the exact selection", async () => {
    const fake = fakeSessions();
    const context = contextWith(payload("investigate"), { sessions: fake.sessions, runtime: "idle" });
    clickHandler(renderedLabel(context), "archive")(fakeEvent());
    await flushMicro();
    expect(fake.archive).toHaveBeenCalledWith(SELECTION);
  });

  it("refuses to archive when the catalog snapshot is unreadable, without an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const fake = fakeSessions();
      // No `runtime` option: the context keeps the fixture catalog, whose
      // `sessions.get` rejects. "Cannot prove not-busy" must archive nothing.
      const context = contextWith(payload("investigate"), { sessions: fake.sessions });
      const event = fakeEvent();
      expect(() => {
        clickHandler(renderedLabel(context), "archive")(event);
      }).not.toThrow();
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(event.stopPropagation).toHaveBeenCalledTimes(1);
      await flushAll();
      expect(fake.archive).not.toHaveBeenCalled();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("restores an archived row with the exact selection and never archives", async () => {
    const fake = fakeSessions();
    const navigate = vi.fn();
    const context = contextWith(payload("task"), { sessions: fake.sessions, archived: true, navigate });
    clickHandler(renderedLabel(context), "restore")(fakeEvent());
    await flushMicro();
    expect(fake.restore).toHaveBeenCalledWith(SELECTION);
    expect(fake.archive).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("swallows lifecycle failures, leaves no unhandled rejection, and never navigates or pins", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const navigate = vi.fn();
      const failingArchive = fakeSessions({ reject: "archive" });
      const archiveContext = contextWith(payload("investigate"), {
        navigate,
        sessions: failingArchive.sessions,
        runtime: "idle",
      });
      expect(() => {
        clickHandler(renderedLabel(archiveContext), "archive")(fakeEvent());
      }).not.toThrow();

      const failingGet = fakeSessions({ reject: "get" });
      const pinContext = contextWith(payload("investigate"), { navigate, sessions: failingGet.sessions });
      expect(() => {
        clickHandler(renderedLabel(pinContext), "pin")(fakeEvent());
      }).not.toThrow();

      const failingRestore = fakeSessions({ reject: "restore" });
      const restoreContext = contextWith(payload("task"), {
        navigate,
        sessions: failingRestore.sessions,
        archived: true,
      });
      expect(() => {
        clickHandler(renderedLabel(restoreContext), "restore")(fakeEvent());
      }).not.toThrow();

      await flushAll();
      expect(rejections).toEqual([]);
      expect(failingGet.pin).not.toHaveBeenCalled();
      expect(failingGet.unpin).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("makes every lifecycle click inert row-wise: default prevented, propagation stopped, no navigation", async () => {
    const fake = fakeSessions();
    const navigate = vi.fn();
    const active = renderedLabel(contextWith(payload("investigate"), { navigate, sessions: fake.sessions }));
    const archived = renderedLabel(
      contextWith(payload("task"), { navigate, sessions: fake.sessions, archived: true }),
    );
    const clicks: Array<[TemplateResult, "pin" | "archive" | "restore"]> = [
      [active, "pin"],
      [active, "archive"],
      [archived, "restore"],
    ];
    for (const [template, match] of clicks) {
      const event = fakeEvent();
      clickHandler(template, match)(event);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    }
    await flushMicro();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("buildSessionLifecycleHandlers exposes one synchronous handler per action", () => {
    const fake = fakeSessions();
    const handlers = buildSessionLifecycleHandlers(contextWith(payload("investigate"), { sessions: fake.sessions }), fake.sessions);
    for (const action of ["pin", "archive", "restore"] as const) expect(typeof handlers[action]).toBe("function");
  });
});

describe("openseReopenDestination", () => {
  it("builds the exact complete destination using the panel's element deep-link key", () => {
    expect(openseReopenDestination("machine-9", testWorkspace, PANEL_ID, "Pkg::Wheel")).toEqual({
      machineId: "machine-9",
      projectId: "project-1",
      workspaceId: "workspace-1",
      view: "workspace",
      tool: PANEL_ID,
      query: { element: "Pkg::Wheel" },
    });
  });
});
