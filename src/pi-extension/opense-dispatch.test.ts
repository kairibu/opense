// @vitest-environment node
//
// Unit tests for the OpenSE Pi extension (plan-v5 §2.E E1, mirroring
// opendoor's opendoor-review.test.ts): the shared `/opense-investigate` /
// `/opense-task` argument parsing (first token = element, remainder =
// instruction verbatim), the metadata payload (equality with the shipped
// strict builder), the session-name bound, the exact bridge frame shape with
// its SYNCHRONOUS receipt, the active-session capture/clear wiring, and
// every reported outcome for both ops. Host-independent: the released bridge
// is not imported; its channel literal is pinned by the extension and
// duplicated here as the test expectation (drift detection).

import { describe, expect, it, vi, type Mock } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultInvestigateInstruction, defaultTaskInstruction } from "../opense-prompts.js";
import {
  buildOpenseSessionMetadata,
  OPENSE_SESSION_METADATA_NAMESPACE,
} from "../opense-session-metadata.js";
import extension, {
  defaultDispatchInstruction,
  dispatchSessionName,
  OPENSE_DISPATCH_COMMANDS,
  OPENSE_DISPATCH_MESSAGE_CUSTOM_TYPE,
  OPENSE_INVESTIGATE_COMMAND,
  OPENSE_TASK_COMMAND,
  parseDispatchCommandArgs,
  PI_WEB_SESSION_DISPATCH_CHANNEL,
  runOpenseDispatch,
} from "./opense-dispatch.js";

/** The channel literal the released host bridge listens on
 *  (`dist/server/sessions/extensionSessionDispatch.js`). Duplicated on
 *  purpose: if the host ever renames it, this test and the extension comment
 *  are the two places that must change together (the intervention signal). */
const EXPECTED_CHANNEL = "pi-web:session-dispatch:v1";

interface CapturedFrame {
  readonly input: Record<string, unknown>;
  readonly accept: ((result: unknown) => void) | undefined;
}

interface FakePi {
  readonly pi: ExtensionAPI;
  /** Registered command handlers by command name. */
  readonly commands: Map<string, (args: string) => Promise<void>>;
  /** Registered `pi.on` event handlers by event name. */
  readonly events: Map<string, (event: unknown, ctx: unknown) => void>;
  /** Every string reported through `pi.sendMessage` (content is always a
   *  string here). */
  readonly messages: string[];
  /** Every emitted frame, in order. */
  readonly frames: CapturedFrame[];
  /** The `pi.sendMessage` spy (also the recorder behind `messages`). */
  readonly sendMessage: Mock;
  /** Fire `session_start` with a stub context (captures it in the factory). */
  readonly startSession: () => void;
  /** Fire `session_shutdown` (clears the captured context). */
  readonly shutdownSession: () => void;
}

/** A stubbed `pi`: command/event registrations are captured, `events.emit`
 *  forwards to `onEmit` (which decides whether/when to call `accept`), and
 *  `sendMessage` records every reported outcome. */
function createPi(onEmit?: (frame: CapturedFrame) => void): FakePi {
  const commands = new Map<string, (args: string) => Promise<void>>();
  const events = new Map<string, (event: unknown, ctx: unknown) => void>();
  const messages: string[] = [];
  const frames: CapturedFrame[] = [];
  const sendMessage = vi.fn((message: { content?: unknown }) => {
    messages.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
  });
  const pi = {
    registerCommand: (name: string, options: { handler: (args: string) => Promise<void> }) => {
      commands.set(name, options.handler);
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      events.set(event, handler);
    },
    events: {
      emit: (_channel: string, data: unknown) => {
        const frame = data as CapturedFrame;
        frames.push(frame);
        onEmit?.(frame);
      },
    },
    sendMessage,
  };
  const startSession = () => {
    events.get("session_start")?.({ reason: "startup" }, {} as ExtensionContext);
  };
  const shutdownSession = () => {
    events.get("session_shutdown")?.({ reason: "quit" }, undefined);
  };
  return { pi: pi as unknown as ExtensionAPI, commands, events, messages, frames, sendMessage, startSession, shutdownSession };
}

/** A `pi` stub whose emitter never calls `accept` (a host without the
 *  dispatch bridge). */
function piWithoutBridge(): FakePi {
  return createPi();
}

/** A `pi` stub whose emitter calls `accept` SYNCHRONOUSLY with `result` —
 *  exactly the released bridge's receipt discipline. */
function piWithBridge(result: Promise<unknown>): FakePi {
  return createPi((frame) => {
    frame.accept?.(result);
  });
}

/** Run one op through the testable core with a live session context. */
function runWithSession(pi: ExtensionAPI, args: string, op: "investigate" | "task"): Promise<void> {
  return runOpenseDispatch(pi, args, op, () => ({}) as ExtensionContext);
}

/** Run one op through the testable core with NO active session. */
function runWithoutSession(pi: ExtensionAPI, args: string, op: "investigate" | "task"): Promise<void> {
  return runOpenseDispatch(pi, args, op, () => undefined);
}

describe("extension registration", () => {
  it("registers both /opense-investigate and /opense-task commands from the default export", () => {
    const created = createPi();
    extension(created.pi);
    expect([...created.commands.keys()]).toEqual([OPENSE_INVESTIGATE_COMMAND, OPENSE_TASK_COMMAND]);
    expect(OPENSE_DISPATCH_COMMANDS).toEqual(["investigate", "task"]);
  });

  it("captures the session context on session_start and clears it on session_shutdown", async () => {
    const created = piWithBridge(Promise.resolve({ sessionId: "s" }));
    extension(created.pi);

    // Before any session_start the command reports instead of dispatching.
    await created.commands.get(OPENSE_INVESTIGATE_COMMAND)?.("Pkg::Wheel");
    expect(created.frames).toHaveLength(0);
    expect(created.messages[0]).toContain("needs an active Pi session");

    // After session_start the same command dispatches.
    created.startSession();
    await created.commands.get(OPENSE_INVESTIGATE_COMMAND)?.("Pkg::Wheel");
    expect(created.frames).toHaveLength(1);

    // session_shutdown clears the context again.
    created.shutdownSession();
    await created.commands.get(OPENSE_TASK_COMMAND)?.("Pkg::Wheel");
    expect(created.frames).toHaveLength(1);
    expect(created.messages.at(-1)).toContain("needs an active Pi session");
  });

  it("pins the host bridge channel literal (drift is an intervention signal)", () => {
    expect(PI_WEB_SESSION_DISPATCH_CHANNEL).toBe(EXPECTED_CHANNEL);
  });
});

describe("parseDispatchCommandArgs", () => {
  it("takes the first whitespace-delimited token as the element and the rest verbatim", () => {
    expect(parseDispatchCommandArgs("Pkg::Wheel")).toEqual({ element: "Pkg::Wheel", instruction: "" });
    expect(parseDispatchCommandArgs("  Pkg::Wheel  ")).toEqual({ element: "Pkg::Wheel", instruction: "" });
    expect(parseDispatchCommandArgs("Pkg::Wheel\nInvestigate Pkg::Wheel and summarise it.")).toEqual({
      element: "Pkg::Wheel",
      instruction: "Investigate Pkg::Wheel and summarise it.",
    });
    expect(parseDispatchCommandArgs("Pkg::Wheel review the rim")).toEqual({
      element: "Pkg::Wheel",
      instruction: "review the rim",
    });
  });

  it("rejects a blank command (no element)", () => {
    expect(parseDispatchCommandArgs("")).toBeUndefined();
    expect(parseDispatchCommandArgs("   \n ")).toBeUndefined();
  });
});

describe("defaultDispatchInstruction / dispatchSessionName", () => {
  it("reuses the shipped prompt builders for both bare-command fallbacks", () => {
    expect(defaultDispatchInstruction("investigate", "Pkg::Wheel")).toBe(defaultInvestigateInstruction("Pkg::Wheel"));
    expect(defaultDispatchInstruction("task", "Pkg::Wheel")).toBe(defaultTaskInstruction("Pkg::Wheel"));
  });

  it("builds per-op session names inside the host's 60-character bound", () => {
    expect(dispatchSessionName("investigate", "Pkg::Wheel")).toBe("OpenSE investigate Pkg::Wheel");
    expect(dispatchSessionName("task", "Pkg::Wheel")).toBe("OpenSE task Pkg::Wheel");
    // Hard truncation at the host's `requireInitialSessionName` bound: the
    // 60-character cut can only tail-truncate the qualified name.
    const long = dispatchSessionName("investigate", `Pkg::${"W".repeat(100)}`);
    expect(long).toBe(`OpenSE investigate Pkg::${"W".repeat(60 - "OpenSE investigate Pkg::".length)}`);
    expect(long.length).toBe(60);
    expect(long.trim()).toBe(long);
  });
});

describe("runOpenseDispatch", () => {
  it("emits the exact bridge frame with the shipped metadata payload and a synchronous receipt (investigate)", async () => {
    const { pi, frames } = piWithBridge(Promise.resolve({ sessionId: "session-1", cwd: "/workspace/demo" }));
    await runWithSession(pi, "Pkg::Wheel", "investigate");

    expect(frames).toHaveLength(1);
    const frame = frames[0];
    if (frame === undefined) throw new Error("frame");
    expect(Object.keys(frame.input).sort()).toEqual(["metadata", "name", "prompt"]);
    expect(frame.input["name"]).toBe("OpenSE investigate Pkg::Wheel");
    expect(frame.input["prompt"]).toBe(defaultInvestigateInstruction("Pkg::Wheel"));
    expect(frame.input["metadata"]).toEqual({
      [OPENSE_SESSION_METADATA_NAMESPACE]: buildOpenseSessionMetadata("investigate", ["Pkg::Wheel"]),
    });
    expect(typeof frame.accept).toBe("function");
  });

  it("emits the task twin frame (E-D2′: both flows dispatch)", async () => {
    const { pi, frames } = piWithBridge(Promise.resolve({ sessionId: "session-2" }));
    await runWithSession(pi, "Pkg::Wheel", "task");

    const frame = frames[0];
    if (frame === undefined) throw new Error("frame");
    expect(frame.input["name"]).toBe("OpenSE task Pkg::Wheel");
    expect(frame.input["prompt"]).toBe(defaultTaskInstruction("Pkg::Wheel"));
    expect(frame.input["metadata"]).toEqual({
      [OPENSE_SESSION_METADATA_NAMESPACE]: buildOpenseSessionMetadata("task", ["Pkg::Wheel"]),
    });
  });

  it("uses caller instructions verbatim instead of composing the built-in instruction twice", async () => {
    const instruction = "Investigate Tracker::Parts::lens and summarise its structure, behaviour, and requirements.";
    const investigate = piWithBridge(Promise.resolve({ sessionId: "s" }));
    await runWithSession(investigate.pi, `Tracker::Parts::lens\n${instruction}`, "investigate");
    expect(investigate.frames[0]?.input["prompt"]).toBe(instruction);

    const task = piWithBridge(Promise.resolve({ sessionId: "s" }));
    await runWithSession(task.pi, "Tracker::Parts::lens review the lens", "task");
    expect(task.frames[0]?.input["prompt"]).toBe("review the lens");
  });

  it("treats a trailing newline after the element as an empty instruction", async () => {
    const { pi, frames } = piWithBridge(Promise.resolve({ sessionId: "s" }));
    await runWithSession(pi, "Pkg::Wheel\n", "investigate");
    expect(frames[0]?.input["prompt"]).toBe(defaultInvestigateInstruction("Pkg::Wheel"));
  });

  it("reports a blank command as usage, naming the command, without emitting a frame", async () => {
    for (const op of ["investigate", "task"] as const) {
      const { pi, frames, messages } = piWithoutBridge();
      await runWithSession(pi, "   ", op);
      expect(frames).toHaveLength(0);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(`Usage: /${op === "investigate" ? OPENSE_INVESTIGATE_COMMAND : OPENSE_TASK_COMMAND}`);
      expect(messages[0]).toContain("<element>");
      expect(messages[0]).toContain(op === "investigate" ? "[instruction…]" : "[task…]");
    }
  });

  it("reports instead of dispatching when there is no active Pi session", async () => {
    const { pi, frames, messages } = piWithoutBridge();
    await runWithoutSession(pi, "Pkg::Wheel", "investigate");
    expect(frames).toHaveLength(0);
    expect(messages[0]).toContain("needs an active Pi session");
  });

  it("rejects an element outside the shipped safe-token rule without emitting a frame", async () => {
    const { pi, frames, messages } = piWithoutBridge();
    await runWithSession(pi, "Wheel", "investigate");
    expect(frames).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Invalid OpenSE session metadata element");
  });

  it("rejects a whitespace-carrying element through the same strict builder", async () => {
    const { pi, frames, messages } = piWithoutBridge();
    // A quoted segment with an inner space splits the first token: the strict
    // builder is the single place that refuses it.
    await runWithSession(pi, "Pkg::'needs focus'", "task");
    expect(frames).toHaveLength(0);
    expect(messages[0]).toContain("Invalid OpenSE session metadata element");
  });

  it("resolves (never throws) and reports when the host has no dispatch bridge", async () => {
    const { pi, frames, messages } = piWithoutBridge();
    await expect(runWithSession(pi, "Pkg::Wheel", "investigate")).resolves.toBeUndefined();
    // The frame was still emitted — the bridge's absence is only observable
    // through `accept` never being called.
    expect(frames).toHaveLength(1);
    expect(messages[0]).toContain("requires PI WEB's session dispatch bridge");
  });

  it("reports a rejected accepted-promise verbatim", async () => {
    const { pi, messages } = piWithBridge(
      Promise.reject(new Error("Session dispatch is disabled for this session")),
    );
    await expect(runWithSession(pi, "Pkg::Wheel", "investigate")).resolves.toBeUndefined();
    expect(messages[0]).toContain("was not started");
    expect(messages[0]).toContain("Session dispatch is disabled for this session");
  });

  it("reports success with the spawned session id for both ops", async () => {
    const investigate = piWithBridge(Promise.resolve({ sessionId: "session-9", cwd: "/workspace/demo" }));
    await runWithSession(investigate.pi, "Pkg::Wheel", "investigate");
    expect(investigate.messages[0]).toContain("Started an independent OpenSE investigate session for Pkg::Wheel");
    expect(investigate.messages[0]).toContain("session-9");

    const task = piWithBridge(Promise.resolve({ sessionId: "session-10" }));
    await runWithSession(task.pi, "Pkg::Wheel", "task");
    expect(task.messages[0]).toContain("Started an independent OpenSE task session for Pkg::Wheel");
    expect(task.messages[0]).toContain("session-10");
  });

  it("reports success without inventing a session id when the result is bare", async () => {
    const { pi, messages } = piWithBridge(Promise.resolve(undefined));
    await runWithSession(pi, "Pkg::Wheel", "investigate");
    expect(messages[0]).toContain("Started an independent OpenSE investigate session for Pkg::Wheel");
    expect(messages[0]).not.toContain("(session");
  });

  it("reports non-Error rejections without producing an empty message", async () => {
    const { pi, messages } = piWithBridge(Promise.reject("boom"));
    await runWithSession(pi, "Pkg::Wheel", "task");
    expect(messages[0]).toContain("boom");
  });

  it("reports through ONE shared displayed custom message type for both ops", async () => {
    const investigate = piWithBridge(Promise.resolve({ sessionId: "s" }));
    await runWithSession(investigate.pi, "Pkg::Wheel", "investigate");
    expect(investigate.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: OPENSE_DISPATCH_MESSAGE_CUSTOM_TYPE, display: true }),
    );

    const task = piWithBridge(Promise.resolve({ sessionId: "s" }));
    await runWithSession(task.pi, "Pkg::Wheel", "task");
    expect(task.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: OPENSE_DISPATCH_MESSAGE_CUSTOM_TYPE, display: true }),
    );
    expect(OPENSE_DISPATCH_MESSAGE_CUSTOM_TYPE).toBe("opense-dispatch");
  });
});
