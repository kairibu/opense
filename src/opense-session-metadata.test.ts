// @vitest-environment node
//
// Unit tests for the shared public session-metadata schema (plan-v5 §2.E E3,
// mirroring opendoor's doorstop-session-metadata.test.ts): the strict
// extension-side builder and the tolerant browser-side parser, including the
// secrets policy (exactly the three schema keys), the safe-token element
// rule on top of the shared C2/C4 qualified-name grammar, and the
// junk/foreign/future-schema tolerance — across BOTH op values (E-D2′ ships
// investigate and task from day one, unlike opendoor's single-value slice).

import { describe, expect, it } from "vitest";
import {
  buildOpenseSessionMetadata,
  OPENSE_SESSION_METADATA_MAX_ELEMENT_LENGTH,
  OPENSE_SESSION_METADATA_MAX_ELEMENTS,
  OPENSE_SESSION_METADATA_NAMESPACE,
  OPENSE_SESSION_METADATA_SCHEMA,
  parseOpenseSessionMetadata,
  type OpenseSessionMetadataOp,
} from "./opense-session-metadata.js";

/** Opaque cast for the unknown-op rejection case (the public type is the
 *  reviewed enum; the test feeds the runtime a value outside it). */
function asOp(value: string): OpenseSessionMetadataOp {
  return value as OpenseSessionMetadataOp;
}

describe("buildOpenseSessionMetadata", () => {
  it("round-trips through the tolerant parser and pins the namespace/schema", () => {
    expect(OPENSE_SESSION_METADATA_NAMESPACE).toBe("opense");
    expect(OPENSE_SESSION_METADATA_SCHEMA).toBe(1);

    const built = buildOpenseSessionMetadata("investigate", ["Pkg::Wheel"]);
    expect(built).toEqual({ schema: 1, op: "investigate", elements: ["Pkg::Wheel"] });
    expect(parseOpenseSessionMetadata(built)).toEqual(built);
    expect(parseOpenseSessionMetadata({ ...built })).toEqual(built);
  });

  it("ships BOTH op values day one (E-D2′: investigate and task)", () => {
    const investigate = buildOpenseSessionMetadata("investigate", ["Pkg::Wheel"]);
    const task = buildOpenseSessionMetadata("task", ["Pkg::Wheel"]);
    expect(investigate.op).toBe("investigate");
    expect(task.op).toBe("task");
    expect(parseOpenseSessionMetadata(investigate)?.op).toBe("investigate");
    expect(parseOpenseSessionMetadata(task)?.op).toBe("task");
  });

  it("accepts quoted segment names that stay single safe tokens", () => {
    const built = buildOpenseSessionMetadata("task", ["Pkg::'needs-focus'"]);
    expect(built.elements).toEqual(["Pkg::'needs-focus'"]);
    expect(parseOpenseSessionMetadata(built)).toEqual(built);
  });

  it("publishes exactly the three schema keys (secrets policy by construction)", () => {
    const built = buildOpenseSessionMetadata("investigate", ["Pkg::Wheel"]);
    expect(Object.keys(built).sort()).toEqual(["elements", "op", "schema"]);
  });

  it("copies the element list so frozen/aliased inputs cannot leak aliases", () => {
    const elements = Object.freeze(["Pkg::Wheel"]);
    const built = buildOpenseSessionMetadata("investigate", elements);
    expect(built.elements).not.toBe(elements);
    expect(built.elements).toEqual(["Pkg::Wheel"]);
  });

  it("rejects junk: unknown op, empty/oversized lists, and invalid elements", () => {
    expect(() => buildOpenseSessionMetadata(asOp("delete"), ["Pkg::Wheel"])).toThrow(
      "Unsupported OpenSE session metadata op",
    );
    expect(() => buildOpenseSessionMetadata("investigate", [])).toThrow("requires 1..1 elements");
    expect(() =>
      buildOpenseSessionMetadata(
        "investigate",
        Array.from({ length: OPENSE_SESSION_METADATA_MAX_ELEMENTS + 1 }, () => "Pkg::Wheel"),
      ),
    ).toThrow("requires 1..1 elements");
  });

  it("rejects elements outside the safe-token + qualified-name + length rule", () => {
    // Not a qualified name at all (single segment, unquoted junk).
    expect(() => buildOpenseSessionMetadata("investigate", ["Wheel"])).toThrow(
      "Invalid OpenSE session metadata element",
    );
    expect(() => buildOpenseSessionMetadata("investigate", ["bad!name::x"])).toThrow(
      "Invalid OpenSE session metadata element",
    );
    // Empty / non-string elements.
    expect(() => buildOpenseSessionMetadata("investigate", [""])).toThrow(
      "Invalid OpenSE session metadata element",
    );
    expect(() => buildOpenseSessionMetadata("investigate", [42 as never])).toThrow(
      "Invalid OpenSE session metadata element",
    );
    // Whitespace anywhere breaks the dispatch command's first-token parse:
    // inner spaces in a quoted segment are unpublishable by construction.
    expect(() => buildOpenseSessionMetadata("investigate", ["Pkg::needs focus"])).toThrow(
      "Invalid OpenSE session metadata element",
    );
    expect(() => buildOpenseSessionMetadata("investigate", ["Pkg::'needs focus'"])).toThrow(
      "Invalid OpenSE session metadata element",
    );
    // Control characters are never safe tokens.
    expect(() => buildOpenseSessionMetadata("investigate", ["Pkg::W\u0007heel"])).toThrow(
      "Invalid OpenSE session metadata element",
    );
    // Over-long element: the bound is a safe-token length, not a byte size.
    expect(() =>
      buildOpenseSessionMetadata("investigate", [`Pkg::${"W".repeat(OPENSE_SESSION_METADATA_MAX_ELEMENT_LENGTH)}`]),
    ).toThrow("Invalid OpenSE session metadata element");
    // The bound is inclusive: exactly 128 characters is still publishable
    // (`Pkg::` is 5 of them, so the segment takes the remaining 123).
    expect(
      buildOpenseSessionMetadata("investigate", [`Pkg::${"W".repeat(OPENSE_SESSION_METADATA_MAX_ELEMENT_LENGTH - 5)}`])
        .elements,
    ).toHaveLength(1);
  });
});

describe("parseOpenseSessionMetadata", () => {
  it("returns undefined for absent, non-object, and foreign shapes", () => {
    expect(parseOpenseSessionMetadata(undefined)).toBeUndefined();
    expect(parseOpenseSessionMetadata(null)).toBeUndefined();
    expect(parseOpenseSessionMetadata("Pkg::Wheel")).toBeUndefined();
    expect(parseOpenseSessionMetadata(42)).toBeUndefined();
    expect(parseOpenseSessionMetadata([])).toBeUndefined();
    expect(parseOpenseSessionMetadata({})).toBeUndefined();
  });

  it("returns undefined for a future schema, unknown op, and malformed element lists", () => {
    expect(parseOpenseSessionMetadata({ schema: 2, op: "investigate", elements: ["Pkg::Wheel"] })).toBeUndefined();
    expect(parseOpenseSessionMetadata({ schema: 1, op: "merge", elements: ["Pkg::Wheel"] })).toBeUndefined();
    expect(parseOpenseSessionMetadata({ schema: 1, op: "investigate" })).toBeUndefined();
    expect(parseOpenseSessionMetadata({ schema: 1, op: "investigate", elements: [] })).toBeUndefined();
    expect(parseOpenseSessionMetadata({ schema: 1, op: "investigate", elements: "Pkg::Wheel" })).toBeUndefined();
    expect(parseOpenseSessionMetadata({ schema: 1, op: "investigate", elements: [""] })).toBeUndefined();
    expect(parseOpenseSessionMetadata({ schema: 1, op: "investigate", elements: [1] })).toBeUndefined();
    expect(parseOpenseSessionMetadata({ schema: 1, op: "investigate", elements: ["Wheel"] })).toBeUndefined();
    expect(parseOpenseSessionMetadata({ schema: 1, op: "investigate", elements: ["Pkg::needs focus"] })).toBeUndefined();
    expect(
      parseOpenseSessionMetadata({
        schema: 1,
        op: "investigate",
        elements: Array.from({ length: OPENSE_SESSION_METADATA_MAX_ELEMENTS + 1 }, () => "Pkg::Wheel"),
      }),
    ).toBeUndefined();
  });

  it("normalizes extra keys away and accepts a frozen payload", () => {
    const parsed = parseOpenseSessionMetadata(
      Object.freeze({
        schema: 1,
        op: "task",
        elements: Object.freeze(["Pkg::Wheel"]),
        secret: "nope",
      }),
    );
    expect(parsed).toEqual({ schema: 1, op: "task", elements: ["Pkg::Wheel"] });
    expect(Object.keys(parsed ?? {}).sort()).toEqual(["elements", "op", "schema"]);
  });
});
