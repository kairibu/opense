// Layer 1 (node env): OpenSE workspace-report contract — response-shape
// guards plus the vendor→plugin-local narrowing adapter driven by a real
// vendored Workspace (fine here: node imports the bundle directly).

import { describe, expect, it } from "vitest";
import { loadModel } from "./vendor/sysml-parser.bundle.js";
import {
  openseReportFromWorkspace,
  parseOpenseWorkspaceReport,
  type OutlineRow,
} from "./opense-contract.js";

const validReport = {
  diagnostics: [
    { severity: "error", path: "model/a.sysml", message: "Lexer error at 1:5 — unexpected token" },
    { severity: "warning", message: "diagnostic without a path" },
  ],
  outline: [
    { id: "Pkg", kind: "package", name: "Pkg", qualifiedName: "Pkg" },
    { id: "Pkg::<doc>", kind: "doc", parentId: "Pkg" },
  ],
  ok: false,
  parsedFileCount: 3,
};

describe("parseOpenseWorkspaceReport", () => {
  it("parses a valid report and passes values through", () => {
    const report = parseOpenseWorkspaceReport(validReport);
    expect(report).toEqual(validReport);
  });

  it("omits optional fields that the input omits (no defaulting)", () => {
    const report = parseOpenseWorkspaceReport(validReport);
    const docRow = report.outline.find((row) => row.id === "Pkg::<doc>");
    if (docRow === undefined) throw new Error("expected the unnamed outline row");
    expect("name" in docRow).toBe(false);
    expect("qualifiedName" in docRow).toBe(false);
    expect("parentId" in docRow).toBe(true);

    const noPath = report.diagnostics.find((d) => d.severity === "warning");
    if (noPath === undefined) throw new Error("expected the pathless diagnostic");
    expect("path" in noPath).toBe(false);
  });

  it("rejects non-object input", () => {
    for (const value of [null, 42, "x", [], true]) {
      expect(() => parseOpenseWorkspaceReport(value)).toThrow("OpenSE workspace report must be an object");
    }
  });

  it("rejects malformed report fields", () => {
    expect(() =>
      parseOpenseWorkspaceReport({ diagnostics: [], outline: [], ok: "yes", parsedFileCount: 1 }),
    ).toThrow("Expected boolean field: ok");
    expect(() =>
      parseOpenseWorkspaceReport({ outline: [], ok: true, parsedFileCount: 1 }),
    ).toThrow("diagnostics must be an array");
    expect(() =>
      parseOpenseWorkspaceReport({ diagnostics: [], outline: "nope", ok: true, parsedFileCount: 1 }),
    ).toThrow("outline must be an array");
    expect(() =>
      parseOpenseWorkspaceReport({ diagnostics: [], outline: [], ok: true, parsedFileCount: "2" }),
    ).toThrow("Expected finite number field: parsedFileCount");
    expect(() =>
      parseOpenseWorkspaceReport({ diagnostics: [], outline: [], ok: true, parsedFileCount: Number.NaN }),
    ).toThrow("Expected finite number field: parsedFileCount");
    expect(() =>
      parseOpenseWorkspaceReport({ diagnostics: [], outline: [], ok: true, parsedFileCount: Number.POSITIVE_INFINITY }),
    ).toThrow("Expected finite number field: parsedFileCount");
  });

  it("rejects malformed diagnostic entries", () => {
    const malformed = (diagnostics: unknown): unknown => ({ diagnostics, outline: [], ok: true, parsedFileCount: 1 });
    expect(() => parseOpenseWorkspaceReport(malformed([{ severity: "fatal", message: "x" }])))
      .toThrow("Invalid workspace diagnostic severity");
    expect(() => parseOpenseWorkspaceReport(malformed([{ severity: "error" }])))
      .toThrow("Expected string field: message");
    expect(() => parseOpenseWorkspaceReport(malformed([{ severity: "error", message: 42 }])))
      .toThrow("Expected string field: message");
    expect(() => parseOpenseWorkspaceReport(malformed([{ severity: "error", path: 7, message: "x" }])))
      .toThrow("Expected string field: path");
    expect(() => parseOpenseWorkspaceReport(malformed(["not a diagnostic"])))
      .toThrow("workspace diagnostic must be an object");
  });

  it("rejects malformed outline rows", () => {
    const malformed = (outline: unknown): unknown => ({ diagnostics: [], outline, ok: true, parsedFileCount: 1 });
    expect(() => parseOpenseWorkspaceReport(malformed([{ kind: "package" }])))
      .toThrow("Expected string field: id");
    expect(() => parseOpenseWorkspaceReport(malformed([{ id: "Pkg" }])))
      .toThrow("Invalid outline row kind");
    expect(() => parseOpenseWorkspaceReport(malformed([{ id: "Pkg", kind: "widget" }])))
      .toThrow("Invalid outline row kind");
    expect(() => parseOpenseWorkspaceReport(malformed([{ id: "Pkg", kind: "package", name: 3 }])))
      .toThrow("Expected string field: name");
    expect(() => parseOpenseWorkspaceReport(malformed([{ id: "Pkg", kind: "package", qualifiedName: false }])))
      .toThrow("Expected string field: qualifiedName");
    expect(() => parseOpenseWorkspaceReport(malformed([{ id: "Pkg", kind: "package", parentId: [] }])))
      .toThrow("Expected string field: parentId");
  });
});

describe("openseReportFromWorkspace (vendor-shape narrowing)", () => {
  it("narrows a real vendored Workspace into a plugin-local report", () => {
    const workspace = loadModel([
      { path: "b.sysml", source: "occurrence def Root;" },
      { path: "a.sysml", source: "occurrence def Root;" },
    ]);
    const outline: OutlineRow[] = [];

    const report = openseReportFromWorkspace(workspace, outline);

    expect(report.ok).toBe(false);
    expect(report.parsedFileCount).toBe(2);
    expect(report.outline).toBe(outline); // outline is plugin-local already: passthrough
    // Diagnostics are validated copies, not reformatted: the parser-owned
    // merge-collision message passes through byte-for-byte.
    expect(report.diagnostics).toEqual(workspace.diagnostics);
    expect(report.diagnostics[0]?.severity).toBe("error");
    expect(report.diagnostics[0]?.path).toBe("b.sysml");
    expect(report.diagnostics[0]?.message).toContain('duplicate top-level occurrence name "Root"');
  });

  it("reports a healthy workspace with no diagnostics as ok", () => {
    const workspace = loadModel([{ path: "single.sysml", source: "package P { part a : T; }" }]);
    const report = openseReportFromWorkspace(workspace, []);
    expect(report.ok).toBe(true);
    expect(report.diagnostics).toEqual([]);
    expect(report.parsedFileCount).toBe(1);
  });

  it("rejects a diagnostics payload that drifted at runtime", () => {
    // The adapter validates every diagnostic at the boundary; a value that
    // no longer matches the vendored shape fails loudly here, not in the
    // panel render path. (Compile-time drift — a renamed .d.ts field — fails
    // this file at typecheck instead, which is the same one-place boundary.)
    const workspace = loadModel([{ path: "a.sysml", source: "package P;" }]);
    // Runtime mutation: the type stays `Workspace`, but the value at the
    // boundary no longer matches the vendored shape.
    Object.assign(workspace, { diagnostics: "not an array" });
    expect(() => openseReportFromWorkspace(workspace, [])).toThrow("diagnostics must be an array");
  });
});