// ---------------------------------------------------------------------------
// Pure prompt builders for the OpenSE element action palette (syside-prompts
// adaptation). No DOM, no parser, no plugin API — trivially testable string
// functions the palette element calls from its button/keydown handlers.
//
// E2 (plan-v5 §2.E): the Investigate/Task actions insert COMPOSED COMMANDS —
// line 1 the `/opense-…` dispatch command of the OpenSE Pi extension, line 2
// the self-sufficient instruction. The extension (when installed) spawns a
// NAMED independent session from that text; without it the current agent
// receives the whole two-liner and the line-2 instruction keeps the flow
// working inline. A subject that is not ONE whitespace-free token (a quoted
// segment with an inner space) composes ONLY the bare instruction — the
// command line could not round-trip the extension's first-token parse.
// `defaultInvestigateInstruction`/`defaultTaskInstruction` are the
// extension's bare-command fallbacks, kept here so the shipped prompt text
// lives in one module.
// ---------------------------------------------------------------------------

import { isDispatchableOpenseSubject } from "./opense-references.js";

/**
 * The `file` clause is emitted only when a non-empty declaring file is
 * available. Unnamed/synthetic elements without provenance simply omit the
 * clause while keeping the trailing period intact.
 */
function locationClause(file: string | undefined): string {
  return file !== undefined && file !== "" ? ` The element is located in ${file}` : "";
}

/** Fixed investigation prompt inserted by the lightbulb action. */
export function contextPrompt(file: string | undefined, subject: string): string {
  return `Investigate ${subject} and summarise its structure, behaviour, and requirements.${locationClause(file)}`;
}

/** Custom-task prompt inserted when the user submits a task for an element. */
export function editPrompt(file: string | undefined, subject: string, task: string): string {
  return `Perform task "${task}" for element ${subject}.${locationClause(file)}`;
}

/**
 * Built-in instruction for a bare `/opense-investigate <element>` (no
 * caller words after the element): the palette always supplies its composed
 * instruction, so this fires only for a manually typed command — still a
 * concrete, self-sufficient instruction for the spawned session, at the
 * task-side wording strength (investigate in the workspace's SysML v2
 * sources, report findings). Shared with the Pi extension
 * (src/pi-extension/opense-dispatch.ts) so its fallback cannot drift from
 * the shipped prompt builders.
 */
export function defaultInvestigateInstruction(subject: string): string {
  return (
    `Investigate ${subject} in the workspace's SysML v2 sources: inspect its structure, behaviour, and ` +
    `requirements, and report your findings.`
  );
}

/**
 * Built-in instruction for a bare `/opense-task <element>` (no caller
 * words after the element): the palette always supplies its composed
 * instruction, so this fires only for a manually typed command — still a
 * concrete, self-sufficient task for the spawned session. Shared with the
 * Pi extension (src/pi-extension/opense-dispatch.ts) so its fallback cannot
 * drift from the shipped prompt builders.
 */
export function defaultTaskInstruction(subject: string): string {
  return (
    `Perform a task for element ${subject}: inspect it in the workspace's SysML v2 sources and ` +
    `carry out one concrete, well-reasoned improvement.`
  );
}

/**
 * Compose the two-line text the Investigate action inserts into the prompt
 * editor: line 1 the `/opense-investigate <qualified-name>` dispatch command,
 * line 2 the self-sufficient investigation instruction
 * ({@link contextPrompt}). The user presses Send.
 *
 * Parse-rule contract with the Pi extension (ONE rule, both flows): the
 * extension takes the FIRST whitespace-delimited token after the command
 * name as the element and treats the REMAINDER verbatim as the spawned
 * session's prompt. Line 2 therefore IS the prompt when the extension is
 * installed (the words are never recomposed), and when it is NOT the
 * current agent receives the whole text — the line-2 instruction keeps the
 * flow working inline and line 1 reads as a plain heading. The same rule
 * serves a manual `/opense-investigate Pkg::Wheel check the rim`: the words
 * after the element become the prompt verbatim.
 *
 * Dispatchability guard: the command line is composed only when the subject
 * is ONE whitespace-free token ({@link isDispatchableOpenseSubject}) — only
 * such a subject round-trips the first-token parse into the strict metadata
 * builder. A subject whose quoted segment carries an inner space
 * (`Tracker::'needs focus'`) composes ONLY the bare instruction
 * ({@link contextPrompt}): the inline fallback survives and the agent works
 * in the current session, instead of the extension refusing a truncated
 * token and the investigation never happening. The quoted-name limitation
 * therefore applies only to a MANUALLY typed `/opense-investigate`
 * command, where the extension reports the invalid element.
 */
export function composeInvestigateCommand(file: string | undefined, subject: string): string {
  const instruction = contextPrompt(file, subject);
  if (!isDispatchableOpenseSubject(subject)) return instruction;
  return `/opense-investigate ${subject}\n${instruction}`;
}

/**
 * Compose the two-line text the custom-Task action inserts into the prompt
 * editor: line 1 the `/opense-task <qualified-name>` dispatch command, line
 * 2 the self-sufficient task instruction ({@link editPrompt}, which carries
 * the task text). The palette's task input is a single-line `<input>`, so
 * the task can never break the line-1 command.
 *
 * Same parse-rule contract and dispatchability guard as
 * {@link composeInvestigateCommand}: first token = element, remainder = the
 * spawned prompt verbatim, and the command line is composed only when the
 * subject is ONE whitespace-free token
 * ({@link isDispatchableOpenseSubject}). A subject whose quoted segment
 * carries an inner space (`Tracker::'needs focus'`) composes ONLY the bare
 * instruction ({@link editPrompt}) — the inline fallback survives and the
 * agent works in the current session — so the quoted-name limitation
 * applies only to a MANUALLY typed `/opense-task` command, where the
 * extension reports the invalid element. The palette flow carries the
 * composed instruction on line 2, and a manual
 * `/opense-task Pkg::Wheel review the wheel` makes those trailing words the
 * prompt verbatim — one rule for both.
 */
export function composeTaskCommand(file: string | undefined, subject: string, task: string): string {
  const instruction = editPrompt(file, subject, task);
  if (!isDispatchableOpenseSubject(subject)) return instruction;
  return `/opense-task ${subject}\n${instruction}`;
}
