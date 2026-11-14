// Layer 1 (node env): the C4 `[[Pkg::Wheel]]` markdown extension
// (plan-v5 §2.C C4, decision D3) — pure unit cases over the contribution's
// start/tokenize/render contract: start offsets, tokenize consuming ONLY a
// complete well-formed chip at the start of the source (invalid and truncated
// contents fall through unconsumed), and deterministic escaped rendering of
// untrusted chat text.

import { describe, expect, it } from "vitest";
import { escapeOpenseChipHtml, openseReferenceChipExtension } from "./opense-panel-chips.js";

// Entity constants built at runtime: the assertions below compare against
// literal HTML entities, which are written here via fromCharCode so this
// source file itself never carries raw entity sequences.
const AMP = String.fromCharCode(38);
const entity = (name: string) => AMP + name + ";";
const lt = entity("lt");
const gt = entity("gt");
const amp = entity("amp");
const quot = entity("quot");
const apos = entity("#39");

describe("openseReferenceChipExtension shape", () => {
  it("declares the opense-refs inline extension with the three callbacks", () => {
    expect(openseReferenceChipExtension.id).toBe("opense-refs");
    expect(openseReferenceChipExtension.level).toBe("inline");
    expect(typeof openseReferenceChipExtension.start).toBe("function");
    expect(typeof openseReferenceChipExtension.tokenize).toBe("function");
    expect(typeof openseReferenceChipExtension.render).toBe("function");
  });
});

describe("openseReferenceChipExtension.start", () => {
  it("reports the earliest [[ offset, or undefined without one", () => {
    expect(openseReferenceChipExtension.start("plain text")).toBeUndefined();
    expect(openseReferenceChipExtension.start("")).toBeUndefined();
    expect(openseReferenceChipExtension.start("see [[Pkg::Wheel]] here")).toBe(4);
    expect(openseReferenceChipExtension.start("[[Pkg::A]] then [[Pkg::B]]")).toBe(0);
    // Only `[[` matters at this stage — validity is tokenize's job.
    expect(openseReferenceChipExtension.start("x [[not a chip")).toBe(2);
  });
});

describe("openseReferenceChipExtension.tokenize", () => {
  it("tokenizes a complete well-formed chip at the start, excluding trailing text", () => {
    expect(openseReferenceChipExtension.tokenize("[[Pkg::Wheel]]")).toEqual({
      raw: "[[Pkg::Wheel]]",
      text: "Pkg::Wheel",
    });
    expect(openseReferenceChipExtension.tokenize("[[Tracker::'needs focus']] tail")).toEqual({
      raw: "[[Tracker::'needs focus']]",
      text: "Tracker::'needs focus'",
    });
  });

  it("does not consume anything that is not a complete well-formed chip", () => {
    // Invalid contents fall through to the host's own markdown as plain text.
    expect(openseReferenceChipExtension.tokenize("[[junk]]")).toBeUndefined();
    expect(openseReferenceChipExtension.tokenize("[[Pkg::]]")).toBeUndefined();
    expect(openseReferenceChipExtension.tokenize("[[]]")).toBeUndefined();
    // Truncated chip — no closing brackets.
    expect(openseReferenceChipExtension.tokenize("[[Pkg::")).toBeUndefined();
    expect(openseReferenceChipExtension.tokenize("[[")).toBeUndefined();
    // Not at the start, or no chip at all.
    expect(openseReferenceChipExtension.tokenize("x [[Pkg::Wheel]]")).toBeUndefined();
    expect(openseReferenceChipExtension.tokenize("plain")).toBeUndefined();
  });
});

describe("openseReferenceChipExtension.render", () => {
  it("renders a styled span with the escaped name", () => {
    expect(openseReferenceChipExtension.render({ raw: "[[Pkg::Wheel]]", text: "Pkg::Wheel" })).toBe(
      `<span class="opense-ref">Pkg::Wheel</span>`,
    );
  });

  it("escapes HTML-significant characters from untrusted chip names", () => {
    const nasty = `Pkg::'a<b>&"c'd'`;
    const rendered = openseReferenceChipExtension.render({ raw: "[[x]]", text: nasty });
    expect(rendered).toBe(
      `<span class="opense-ref">Pkg::${apos}a${lt}b${gt}${amp}${quot}c${apos}d${apos}</span>`,
    );
    // The unescaped name never appears in the output; the escaped forms do.
    expect(rendered).toContain(`${lt}b${gt}`);
    expect(rendered).not.toContain("<b>");
    expect(rendered).not.toContain(`&"c`);
  });

  it("is deterministic: identical tokens render identically", () => {
    const token = { raw: "[[Pkg::Wheel]]", text: "Pkg::Wheel" };
    expect(openseReferenceChipExtension.render(token)).toBe(openseReferenceChipExtension.render(token));
  });
});

describe("escapeOpenseChipHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeOpenseChipHtml(`&<>"'`)).toBe(`${amp}${lt}${gt}${quot}${apos}`);
    expect(escapeOpenseChipHtml("plain")).toBe("plain");
  });
});
