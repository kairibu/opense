// Pure prompt builders (opense-prompts.ts): string-in/string-out, no DOM.
// E2 adds the composed two-line dispatch commands (line 1 command, line 2
// self-sufficient instruction — the extension's parse rule: first token =
// element, remainder = prompt verbatim). A subject that is not ONE
// whitespace-free token (a quoted segment with an inner space) composes
// only the bare instruction — the command line could not round-trip the
// first-token parse.

import { describe, expect, it } from "vitest";
import {
  composeInvestigateCommand,
  composeTaskCommand,
  contextPrompt,
  defaultInvestigateInstruction,
  defaultTaskInstruction,
  editPrompt,
} from "./opense-prompts.js";

describe("opense prompts", () => {
  it("builds the investigation prompt with the location clause", () => {
    expect(contextPrompt("model/good.sysml", "Tracker::Parts::lens")).toBe(
      "Investigate Tracker::Parts::lens and summarise its structure, behaviour, and requirements. The element is located in model/good.sysml",
    );
  });

  it("omits the location clause when no declaring file is known", () => {
    expect(contextPrompt(undefined, "Tracker::Parts::lens")).toBe(
      "Investigate Tracker::Parts::lens and summarise its structure, behaviour, and requirements.",
    );
    // An empty string is treated like an absent file.
    expect(contextPrompt("", "Tracker")).toBe(
      "Investigate Tracker and summarise its structure, behaviour, and requirements.",
    );
  });

  it("builds the custom-task prompt with the location clause", () => {
    expect(editPrompt("model/good.sysml", "Tracker::Parts::lens", "Add validation")).toBe(
      'Perform task "Add validation" for element Tracker::Parts::lens. The element is located in model/good.sysml',
    );
  });

  it("omits the location clause from the task prompt when no file is known", () => {
    expect(editPrompt(undefined, "Tracker", "Rename lens")).toBe(
      'Perform task "Rename lens" for element Tracker.',
    );
  });
});

describe("composed dispatch commands (E2)", () => {
  it("composes /opense-investigate: line 1 the command, line 2 the instruction", () => {
    const composed = composeInvestigateCommand("model/good.sysml", "Tracker::Parts::lens");
    const lines = composed.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("/opense-investigate Tracker::Parts::lens");
    expect(lines[1]).toBe(contextPrompt("model/good.sysml", "Tracker::Parts::lens"));
  });

  it("keeps the composed investigate command a self-sufficient fallback without a file", () => {
    const lines = composeInvestigateCommand(undefined, "Pkg::Wheel").split("\n");
    expect(lines[0]).toBe("/opense-investigate Pkg::Wheel");
    expect(lines[1]).toBe("Investigate Pkg::Wheel and summarise its structure, behaviour, and requirements.");
  });

  it("composes /opense-task: line 1 the command, line 2 the task-carrying instruction", () => {
    const composed = composeTaskCommand("model/good.sysml", "Tracker::Parts::lens", "Add validation");
    const lines = composed.split("\n");
    expect(lines).toHaveLength(2);
    // The element is the ONLY argument on line 1 — the task text rides in
    // the line-2 instruction, so the extension's first-token parse can never
    // mistake task words for the element.
    expect(lines[0]).toBe("/opense-task Tracker::Parts::lens");
    expect(lines[1]).toBe(editPrompt("model/good.sysml", "Tracker::Parts::lens", "Add validation"));
    expect(lines[1]).toContain('"Add validation"');
  });

  it("keeps the composed task command single-line-safe on line 1 without a file", () => {
    const lines = composeTaskCommand(undefined, "Pkg::Wheel", "review the rim").split("\n");
    expect(lines[0]).toBe("/opense-task Pkg::Wheel");
    expect(lines[1]).toBe('Perform task "review the rim" for element Pkg::Wheel.');
  });

  it("composes only the bare instruction for a quoted subject with an inner space (no command line)", () => {
    // `Tracker::'needs focus'` is a qualified name but not ONE token: the
    // extension's first-token parse would truncate it at the space and the
    // strict metadata builder would refuse the fragment — the investigation
    // would never happen. Both composers therefore emit ONLY the bare
    // instruction, so the inline fallback survives (the agent works in the
    // current session) and no `/opense-` line 1 is inserted at all.
    const subject = "Tracker::'needs focus'";
    const investigate = composeInvestigateCommand("model/good.sysml", subject);
    expect(investigate).toBe(contextPrompt("model/good.sysml", subject));
    expect(investigate).not.toContain("/opense-");
    expect(investigate.split("\n")).toHaveLength(1);

    const task = composeTaskCommand("model/good.sysml", subject, "Add validation");
    expect(task).toBe(editPrompt("model/good.sysml", subject, "Add validation"));
    expect(task).not.toContain("/opense-");
    expect(task.split("\n")).toHaveLength(1);
  });

  it("composes the command line as before for a whitespace-free subject, quoted segments without spaces included", () => {
    // A quoted segment WITHOUT inner whitespace is still ONE token and
    // round-trips the extension's parse — both composers compose the
    // two-line command exactly as before.
    const subject = "Pkg::'deep-span'";
    const investigate = composeInvestigateCommand(undefined, subject).split("\n");
    expect(investigate[0]).toBe(`/opense-investigate ${subject}`);
    expect(investigate[1]).toBe(contextPrompt(undefined, subject));

    const task = composeTaskCommand(undefined, subject, "review the rim").split("\n");
    expect(task[0]).toBe(`/opense-task ${subject}`);
    expect(task[1]).toBe(editPrompt(undefined, subject, "review the rim"));
  });
});

describe("defaultInvestigateInstruction", () => {
  it("builds a concrete, self-sufficient bare-command fallback naming the element", () => {
    const instruction = defaultInvestigateInstruction("Pkg::Wheel");
    expect(instruction).toContain("Pkg::Wheel");
    expect(instruction).toContain("SysML v2 sources");
    // Task-side wording strength: a concrete place to investigate AND an
    // explicit report step, not just a summarise request.
    expect(instruction).toMatch(/report your findings\./u);
  });
});

describe("defaultTaskInstruction", () => {
  it("builds a concrete, self-sufficient bare-command fallback naming the element", () => {
    const instruction = defaultTaskInstruction("Pkg::Wheel");
    expect(instruction).toContain("Pkg::Wheel");
    expect(instruction).toContain("SysML v2");
    // Self-sufficiency: an actionable verb, not a placeholder.
    expect(instruction).toMatch(/improvement\./u);
  });
});
