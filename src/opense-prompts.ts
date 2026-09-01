// ---------------------------------------------------------------------------
// Pure prompt builders for the OpenSE element action palette (syside-prompts
// adaptation). No DOM, no parser, no plugin API — trivially testable string
// functions the palette element calls from its button/keydown handlers.
// ---------------------------------------------------------------------------

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
