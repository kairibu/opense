// Pure prompt builders (opense-prompts.ts): string-in/string-out, no DOM.

import { describe, expect, it } from "vitest";
import { contextPrompt, editPrompt } from "./opense-prompts.js";

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
