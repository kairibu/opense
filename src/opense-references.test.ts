// Layer 1 (node env): OpenSE element-reference extraction (plan-v5 §2.C C2,
// decision D2) — the pure grammar behind the chat message action and the C4
// chip extension. Focused unit cases per the plan's test list: backticked
// spans (multi-segment, quoted segments), `[[...]]` chips, both forms
// deduped, fenced-code exclusion, non-qualified spans rejected, cap, labels,
// and the shared chip-parse helper's round-trip.

import { describe, expect, it } from "vitest";
import {
  OPENSE_REFERENCE_CANDIDATE_LIMIT,
  isDispatchableOpenseSubject,
  isQualifiedOpenseName,
  openseReferenceCandidates,
  openseReferenceLabel,
  parseOpenseChip,
} from "./opense-references.js";

describe("openseReferenceCandidates", () => {
  it("extracts backticked qualified names in first-appearance order", () => {
    expect(openseReferenceCandidates("Use `Vehicle::wheels` and `Pkg::Wheel::rim` here")).toEqual([
      "Vehicle::wheels",
      "Pkg::Wheel::rim",
    ]);
  });

  it("keeps quoted segments whole", () => {
    expect(openseReferenceCandidates("Consider `Tracker::'needs focus'` and `Pkg::'has space'::rim`")).toEqual([
      "Tracker::'needs focus'",
      "Pkg::'has space'::rim",
    ]);
  });

  it("trims surrounding whitespace inside a span", () => {
    expect(openseReferenceCandidates("see ` Pkg::Wheel ` please")).toEqual(["Pkg::Wheel"]);
  });

  it("extracts [[...]] chips", () => {
    expect(openseReferenceCandidates("Inspect [[Pkg::Wheel]] and [[Tracker::'needs focus']]")).toEqual([
      "Pkg::Wheel",
      "Tracker::'needs focus'",
    ]);
  });

  it("matches the host renderer when stray brackets hug a chip", () => {
    // The host's markdown engine (marked) retries inline tokenizers at
    // offset+1 after a failed start, so "[[[Pkg::Wheel]]]" renders a chip
    // from offset 1; a failed chip parse therefore advances ONE character
    // (not past both brackets) so detection and rendering cannot drift —
    // otherwise the chip renders but the action stays hidden.
    expect(openseReferenceCandidates("[[[Pkg::Wheel]]]")).toEqual(["Pkg::Wheel"]);
    // The chip closes at the FIRST "]]": the trailing "]" is not part of
    // the name — the exact extracted string, raw untouched by it.
    expect(parseOpenseChip("[[Pkg::Wheel]]]")).toEqual({ name: "Pkg::Wheel", raw: "[[Pkg::Wheel]]" });
  });

  it("dedupes both forms onto one candidate in first-appearance order", () => {
    expect(openseReferenceCandidates("`Pkg::Wheel` then [[Pkg::Wheel]] then `Pkg::Wheel`")).toEqual([
      "Pkg::Wheel",
    ]);
    expect(openseReferenceCandidates("[[Pkg::Gear]] first, `Pkg::Wheel` second, [[Pkg::Gear]] again")).toEqual([
      "Pkg::Gear",
      "Pkg::Wheel",
    ]);
  });

  it("rejects non-qualified spans and chips", () => {
    // No `::`, empty segments, spaces or leading digits in unquoted segments,
    // quoted FIRST segments (package-style must be unquoted), empty quotes.
    expect(openseReferenceCandidates("`hello` `Pkg::` `::Wheel` `Pkg Wheel::x` `1Pkg::Wheel` `'Pkg'::Wheel` `Pkg::''`")).toEqual([]);
    expect(openseReferenceCandidates("[[junk]] [[Pkg::]] [[Pkg Wheel::x]]")).toEqual([]);
    // Truncated chip: no closing brackets, nothing consumed.
    expect(openseReferenceCandidates("see [[Pkg::Wheel")).toEqual([]);
  });

  it("accepts std::vector grammatically — documented decision, no case heuristics", () => {
    // Two valid unquoted identifiers with a package-style first segment
    // qualify; lowercase is legal SysML, so inventing a case rule would
    // reject legitimate packages. The false positive costs one navigation
    // that lands on C3's honest not-found notice.
    expect(openseReferenceCandidates("compare with `std::vector` — use `Pkg::Wheel`")).toEqual([
      "std::vector",
      "Pkg::Wheel",
    ]);
  });

  it("excludes fenced code blocks (backtick and tilde fences)", () => {
    const text = [
      "before `Pkg::Kept`",
      "```sysml",
      "package Pkg { part Hidden; } // `Pkg::Hidden` and [[Pkg::HiddenChip]]",
      "```",
      "~~~",
      "`Pkg::AlsoHidden`",
      "~~~~",
      "after [[Pkg::KeptToo]]",
    ].join("\n");
    expect(openseReferenceCandidates(text)).toEqual(["Pkg::Kept", "Pkg::KeptToo"]);
  });

  it("swallows the rest of the text for an unclosed fence (CommonMark)", () => {
    expect(
      openseReferenceCandidates("kept `Pkg::Kept`" + "\n```\n" + "`Pkg::Swallowed` [[Pkg::AlsoSwallowed]]"),
    ).toEqual(["Pkg::Kept"]);
  });

  it("does not treat an escaped backtick as a span opener", () => {
    // The escaped backtick is literal text, so the span never opens; the
    // later plain span still counts.
    expect(openseReferenceCandidates("escaped \\` then `Pkg::Gear` ok")).toEqual(["Pkg::Gear"]);
    // Escaping shifts pairing exactly like CommonMark would: here the first
    // unescaped backtick opens a span whose content is " and ", so the
    // shifted candidate in the remainder never pairs up.
    expect(openseReferenceCandidates("escaped \\`Pkg::Wheel` and `Pkg::Gear`")).toEqual([]);
    // An unclosed lone backtick is literal text too — chips after it count.
    expect(openseReferenceCandidates("unclosed ` with [[Pkg::Wheel]] after")).toEqual(["Pkg::Wheel"]);
  });

  it("caps the result at OPENSE_REFERENCE_CANDIDATE_LIMIT in first-appearance order", () => {
    const many: string[] = [];
    for (let index = 0; index < OPENSE_REFERENCE_CANDIDATE_LIMIT + 10; index += 1) {
      many.push(`\`Pkg::El${index}\``);
    }
    const candidates = openseReferenceCandidates(many.join(" "));
    expect(candidates).toHaveLength(OPENSE_REFERENCE_CANDIDATE_LIMIT);
    expect(candidates[0]).toBe("Pkg::El0");
    expect(candidates[OPENSE_REFERENCE_CANDIDATE_LIMIT - 1]).toBe(
      `Pkg::El${OPENSE_REFERENCE_CANDIDATE_LIMIT - 1}`,
    );
  });
});

describe("openseReferenceLabel", () => {
  it("labels a chooser row with the candidate itself", () => {
    expect(openseReferenceLabel("Pkg::Wheel")).toBe("Pkg::Wheel");
    expect(openseReferenceLabel("Tracker::'needs focus'")).toBe("Tracker::'needs focus'");
  });
});

describe("parseOpenseChip", () => {
  it("round-trips a complete chip and excludes trailing text from raw", () => {
    expect(parseOpenseChip("[[Pkg::Wheel]] and more")).toEqual({
      name: "Pkg::Wheel",
      raw: "[[Pkg::Wheel]]",
    });
    expect(parseOpenseChip("[[Tracker::'needs focus']]")).toEqual({
      name: "Tracker::'needs focus'",
      raw: "[[Tracker::'needs focus']]",
    });
  });

  it("returns undefined for anything that is not a complete well-formed chip at the start", () => {
    expect(parseOpenseChip("Pkg::Wheel")).toBeUndefined();
    expect(parseOpenseChip("`Pkg::Wheel`")).toBeUndefined();
    expect(parseOpenseChip("[[junk]]")).toBeUndefined();
    expect(parseOpenseChip("[[Pkg::Wheel")).toBeUndefined(); // truncated
    expect(parseOpenseChip("[[]]")).toBeUndefined();
    expect(parseOpenseChip("x [[Pkg::Wheel]]")).toBeUndefined(); // not at the start
  });
});

describe("isQualifiedOpenseName", () => {
  it("requires two or more segments, first package-style, later segments identifier-or-quoted", () => {
    expect(isQualifiedOpenseName("Pkg::Wheel")).toBe(true);
    expect(isQualifiedOpenseName("Pkg::Wheel::rim::'deep span'")).toBe(true);
    expect(isQualifiedOpenseName("_pkg::x1")).toBe(true);
    expect(isQualifiedOpenseName("Pkg")).toBe(false);
    expect(isQualifiedOpenseName("Pkg::")).toBe(false);
    expect(isQualifiedOpenseName("'Pkg'::Wheel")).toBe(false);
    expect(isQualifiedOpenseName("Pkg::Wheel::")).toBe(false);
    // A `::` inside a quoted segment breaks the segment split first — the
    // pieces fail both segment shapes (conservative by construction).
    expect(isQualifiedOpenseName("Pkg::'a::b'")).toBe(false);
    expect(isQualifiedOpenseName(" Pkg::Wheel ")).toBe(true);
  });
});

describe("isDispatchableOpenseSubject", () => {
  it("accepts only a whitespace-free subject (what the dispatch command's first-token parse can carry)", () => {
    expect(isDispatchableOpenseSubject("Pkg::Wheel")).toBe(true);
    // A quoted segment WITHOUT inner whitespace is still one token.
    expect(isDispatchableOpenseSubject("Pkg::Wheel::rim::'deep-span'")).toBe(true);
    // A quoted segment WITH an inner space is a qualified name but not one
    // token — the composed command line could not round-trip the extension's
    // first-token parse (the composers must fall back to the bare
    // instruction for it).
    expect(isDispatchableOpenseSubject("Tracker::'needs focus'")).toBe(false);
    expect(isDispatchableOpenseSubject("Pkg::Wheel rim")).toBe(false);
    expect(isDispatchableOpenseSubject(" Pkg::Wheel ")).toBe(false);
    expect(isDispatchableOpenseSubject("Pkg::Wheel\n")).toBe(false);
    expect(isDispatchableOpenseSubject("")).toBe(false);
  });
});
