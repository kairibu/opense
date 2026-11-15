// ---------------------------------------------------------------------------
// OpenSE investigate/task dispatch — the Pi-extension half of the palette
// agent actions (plan-v5 §2.E, opendoor pattern — direct adaptation of
// opendoor's `src/pi-extension/opendoor-review.ts`): a minuscule Pi extension
// that registers `/opense-investigate <element> [instruction…]` and
// `/opense-task <element> [task…]` and starts an independent NAMED
// conversation through PI WEB's OWN session-dispatch bridge.
//
// Why an extension rather than any plugin entry: OpenSE is browser-only —
// there is no server process to dispatch from, and the host's `pi-sessions`
// v1 capability can neither name a session nor publish metadata. A trusted
// Pi extension runs inside the initiating session's Pi process, talks to the
// host's builtin per-session dispatch bridge over the documented in-process
// channel, and carries both the explicit `name` and the public `metadata`
// (E3) that power the session-list label (E4).
//
// Discipline (opendoor's, carried over):
//   - ZERO runtime imports of anything outside this package. `ExtensionAPI`/
//     `ExtensionContext` are TYPE-only imports from
//     `@earendil-works/pi-coding-agent` (erased at build); the prompt
//     builders and the metadata module are imported by relative path from the
//     same package (inlined by the bundle), so the shipped
//     `dist/pi-extension/index.js` is self-contained and never reaches into
//     the host's internals.
//   - The dispatch channel literal is HOST-INTERNAL (not exported from the
//     released extension or server contracts). It is pinned here with this
//     comment and asserted by tests against a duplicated expectation — the
//     same discipline opendoor uses. Drift in a future host release is a
//     rejected dispatch (no listener ⇒ no `accept` call) and therefore an
//     intervention signal, never an improvisation site.
//   - Every outcome is reported into the INITIATING conversation via
//     `pi.sendMessage` (a displayed custom message, ONE shared
//     `opense-dispatch` customType whose content names the op): success, a
//     rejected dispatch (delegation disabled, project-scope refusal,
//     oversized prompt), a malformed command, a command without an active
//     session, or a host without the bridge. The handler never throws for an
//     expected failure, so nothing depends on Pi's extension-error path and
//     no outcome is swallowed.
//   - The published metadata is the SHIPPED `{schema: 1, op, elements}`
//     payload under the `opense` namespace (the same contract the shipped
//     session-row label renders); the strict builder is the single
//     validation source, so this module introduces no second element
//     grammar.
//
// Form (E-D2′ plus the E2 parse-rule decision): the FIRST
// whitespace-delimited token after the command is the element qualified name
// and the REMAINDER is the spawned prompt, verbatim. The palette's insert
// always supplies the remainder (its composed line-2 instruction IS the
// prompt — written once by opense-prompts.ts, never recomposed here); the
// built-in instruction is used only when the command carries a bare element,
// so a manual `/opense-task Pkg::Wheel review the wheel` works through the
// same single rule.
//
// Session capture: dispatch requires an active Pi session (the host's bridge
// refuses without one — `extensionSessionDispatch.ts` captures its own
// context the same way), so this extension captures `ExtensionContext` on
// `session_start` and clears it on `session_shutdown`. `session_start`
// re-fires after `/reload` (reason "reload"), so reloading the extension
// mid-session re-captures the context; a command outside a live session is
// reported, never thrown.
// ---------------------------------------------------------------------------

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultInvestigateInstruction, defaultTaskInstruction } from "../opense-prompts.js";
import {
  buildOpenseSessionMetadata,
  OPENSE_SESSION_METADATA_NAMESPACE,
} from "../opense-session-metadata.js";

/**
 * The host's in-process extension dispatch channel. Pinned literal: it is
 * emitted by the host's builtin per-session dispatch bridge
 * (`dist/server/sessions/extensionSessionDispatch.js`) and by the host's own
 * relays extension, but it is not exported from any released contract. A
 * change in a future host release surfaces here as a rejected dispatch (no
 * listener ⇒ no `accept` call), which is the intervention signal.
 */
export const PI_WEB_SESSION_DISPATCH_CHANNEL = "pi-web:session-dispatch:v1";

/** The registered Pi commands (invoked as `/opense-investigate …` and
 *  `/opense-task …`; E-D2′ ships both flows). */
export const OPENSE_INVESTIGATE_COMMAND = "opense-investigate";
export const OPENSE_TASK_COMMAND = "opense-task";

/**
 * `customType` of the displayed message this extension reports outcomes
 * through (rendered in the initiating conversation's transcript). ONE shared
 * type for both ops — the content text names the op — so a future transcript
 * renderer registers one renderer, not two.
 */
export const OPENSE_DISPATCH_MESSAGE_CUSTOM_TYPE = "opense-dispatch";

/** The host's explicit session-name bound (`requireInitialSessionName` in
 *  `sessionNameGenerator.ts`): trimmed, non-empty, at most 60 characters, no
 *  control characters. Names are hard-truncated to it (E3). */
export const OPENSE_SESSION_NAME_MAX_LENGTH = 60;

/** The two dispatch ops (E-D2′). */
export type OpenseDispatchOp = "investigate" | "task";

/** Per-op command surface: the registered command name, its palette text
 *  (also the session-name prefix), the usage argument hint, and the `/help`
 *  description. */
interface OpenseDispatchOpText {
  readonly command: string;
  readonly namePrefix: string;
  readonly argHint: string;
  readonly description: string;
}

const OPENSE_DISPATCH_OPS: Record<OpenseDispatchOp, OpenseDispatchOpText> = {
  investigate: {
    command: OPENSE_INVESTIGATE_COMMAND,
    namePrefix: "OpenSE investigate ",
    argHint: "[instruction\u2026]",
    description:
      "Start an independent OpenSE investigation of a SysML element (e.g. /opense-investigate Pkg::Wheel)",
  },
  task: {
    command: OPENSE_TASK_COMMAND,
    namePrefix: "OpenSE task ",
    argHint: "[task\u2026]",
    description:
      "Start an independent OpenSE task conversation for a SysML element (e.g. /opense-task Pkg::Wheel review the rim)",
  },
};

/** The registered commands, in registration order (tests pin it). */
export const OPENSE_DISPATCH_COMMANDS: readonly OpenseDispatchOp[] = ["investigate", "task"];

/** One parsed `/opense-investigate` or `/opense-task` invocation: the
 *  element qualified name and the caller's remaining words (the palette's
 *  composed instruction, or a user's own text). `instruction` is `""` when
 *  the command carried only an element. */
export interface OpenseDispatchCommandArgs {
  readonly element: string;
  readonly instruction: string;
}

/**
 * Parse a command's argument text (shared by both commands): the FIRST
 * whitespace-delimited token is the element, the remainder is the caller's
 * instruction. Returns `undefined` when there is no element at all (blank
 * command) — the caller reports usage. The element shape is NOT validated
 * here: `buildOpenseSessionMetadata` is the single strict validator (safe
 * token ≤ OPENSE_SESSION_METADATA_MAX_ELEMENT_LENGTH characters under the shared C2/C4 qualified-name grammar), so
 * a junk element is rejected by the shipped contract rather than by a
 * duplicate grammar in this module.
 */
export function parseDispatchCommandArgs(args: string): OpenseDispatchCommandArgs | undefined {
  const trimmed = args.trim();
  if (trimmed === "") return undefined;
  const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(trimmed);
  if (match === null) return undefined;
  const element = match[1] ?? "";
  if (element === "") return undefined;
  return { element, instruction: (match[2] ?? "").trim() };
}

/**
 * The built-in instruction used only for a bare `/<command> <element>`: the
 * palette's composed line-2 instruction is richer and becomes the prompt
 * verbatim when present. Both ops reuse the SHIPPED prompt builders
 * (opense-prompts.ts — `defaultInvestigateInstruction` and
 * `defaultTaskInstruction`, both at task-side wording strength: investigate
 * in the workspace's SysML v2 sources and report findings, or carry out one
 * concrete improvement), so this fallback cannot drift from the palette.
 */
export function defaultDispatchInstruction(op: OpenseDispatchOp, element: string): string {
  return op === "investigate" ? defaultInvestigateInstruction(element) : defaultTaskInstruction(element);
}

/**
 * The spawned session's explicit name: `"OpenSE investigate " + element`
 * (or the task twin), hard-truncated to the host's 60-character bound
 * (`requireInitialSessionName`: trimmed, non-empty, no control characters).
 * The element is a validated whitespace-free token, so truncation can only
 * cut the qualified name's tail — never produce an empty, padded, or
 * control-carrying name — and the defensive trim keeps the slice trimmed
 * for any future prefix change.
 */
export function dispatchSessionName(op: OpenseDispatchOp, element: string): string {
  const name = `${OPENSE_DISPATCH_OPS[op].namePrefix}${element}`.slice(0, OPENSE_SESSION_NAME_MAX_LENGTH);
  return name.trim();
}

/**
 * The Pi extension factory: registers both commands and captures the session
 * context (dispatch requires an active Pi session). The dispatch itself
 * lives in {@link runOpenseDispatch}, which tests drive directly.
 */
export default function openseDispatchExtension(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
  });
  pi.on("session_shutdown", () => {
    context = undefined;
  });
  for (const op of OPENSE_DISPATCH_COMMANDS) {
    pi.registerCommand(OPENSE_DISPATCH_OPS[op].command, {
      description: OPENSE_DISPATCH_OPS[op].description,
      handler: async (args: string) => {
        await runOpenseDispatch(pi, args, op, () => context);
      },
    });
  }
}

/**
 * The whole dispatch, invocation-independent (so it is testable against a
 * stubbed `pi`): parse → active-session gate → strict metadata build → emit
 * the bridge frame → await the synchronously accepted promise → report the
 * outcome into the initiating conversation. Never throws for an expected
 * failure.
 */
export async function runOpenseDispatch(
  pi: ExtensionAPI,
  args: string,
  op: OpenseDispatchOp,
  activeSession: () => ExtensionContext | undefined,
): Promise<void> {
  const opText = OPENSE_DISPATCH_OPS[op];
  const parsed = parseDispatchCommandArgs(args);
  if (parsed === undefined) {
    report(
      pi,
      `Usage: /${opText.command} <element> ${opText.argHint} — the element is a SysML qualified name (e.g. Pkg::Wheel).`,
    );
    return;
  }
  // The bridge refuses to dispatch without an active Pi session; the same
  // guard here reports the failure in this conversation instead of emitting
  // a frame the bridge must reject.
  if (activeSession() === undefined) {
    report(
      pi,
      `The /${opText.command} command needs an active Pi session; no session was started.`,
    );
    return;
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = {
      [OPENSE_SESSION_METADATA_NAMESPACE]: buildOpenseSessionMetadata(op, [parsed.element]),
    };
  } catch (error) {
    report(pi, `Cannot start the OpenSE ${op} session for ${parsed.element}: ${formatError(error)}`);
    return;
  }

  const prompt = parsed.instruction === "" ? defaultDispatchInstruction(op, parsed.element) : parsed.instruction;
  const name = dispatchSessionName(op, parsed.element);

  // The bridge calls `accept` SYNCHRONOUSLY with a promise carrying the
  // validation/spawn outcome; awaiting it is how rejections are observed
  // instead of disappearing into the fire-and-forget event bus.
  let accepted: Promise<unknown> | undefined;
  pi.events.emit(PI_WEB_SESSION_DISPATCH_CHANNEL, {
    input: { prompt, name, metadata },
    accept: (result: unknown) => {
      accepted = result instanceof Promise ? result : Promise.resolve(result);
    },
  });

  if (accepted === undefined) {
    report(
      pi,
      "OpenSE session dispatch requires PI WEB's session dispatch bridge. Update PI WEB and restart " +
        "the session daemon when safe; no session was started.",
    );
    return;
  }

  try {
    const result = await accepted;
    report(pi, `Started an independent OpenSE ${op} session for ${parsed.element}${spawnSuffix(result)}.`);
  } catch (error) {
    report(pi, `The OpenSE ${op} session for ${parsed.element} was not started: ${formatError(error)}`);
  }
}

/** Report one outcome as a displayed custom message in the initiating
 *  conversation. Reporting must never mask the dispatch outcome, so a host
 *  that rejects the message call is tolerated silently. */
function report(pi: ExtensionAPI, text: string): void {
  try {
    pi.sendMessage({
      customType: OPENSE_DISPATCH_MESSAGE_CUSTOM_TYPE,
      content: text,
      display: true,
    });
  } catch {
    // The dispatch already happened (or provably did not); a reporting
    // failure is not a second failure to surface.
  }
}

/** ` (session <id>)` when the accepted result carries a session id, else "". */
function spawnSuffix(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const sessionId = (result as Record<string, unknown>)["sessionId"];
  return typeof sessionId === "string" && sessionId !== "" ? ` (session ${sessionId})` : "";
}

/** Error text for the conversation; never empty. */
function formatError(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  const text = String(error);
  return text === "" ? "unknown error" : text;
}
