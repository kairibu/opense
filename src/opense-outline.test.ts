// Layer 1 (node env): OpenSE outline/detail helpers over the parser's
// ModelIndex. Driven by a real `loadModel` over two fixture sources sharing
// a package name (merge + provenance) and by the real `createModelIndex`
// over hand-built model fixtures (index edge cases); an injected fake index
// locks the "pure over the index surface" seam.

import { describe, expect, it } from "vitest";
import {
  createModelIndex,
  loadModel,
  type ElementFilter,
  type Member,
  type ModelElement,
  type ModelIndex,
  type SysmlModel,
} from "./vendor/sysml-parser.bundle.js";
import { elementDetails, namedOutlineKinds, namedOutlineRows, outlineRows } from "./opense-outline.js";

const originStub = { originOf: () => undefined };

describe("outline over a real merged loadModel workspace", () => {
  // Two sources share the top-level package name: merge + provenance.
  const sources = [
    { path: "model/mounts.sysml", source: "package Tracker {\n  package Parts { part lens : LensCell; }\n}" },
    {
      path: "model/requirements.sysml",
      source: "package Tracker {\n  package Parts { part mount : MountCell; }\n  requirement 'needs focus' { doc /* must focus */ }\n}",
    },
  ];
  const workspace = loadModel(sources);
  const index = createModelIndex(workspace);

  it("merges same-name packages across files into one outline", () => {
    expect(workspace.ok).toBe(true);
    expect(workspace.diagnostics).toEqual([]);
    expect(outlineRows(index)).toEqual([
      { id: "Tracker", kind: "package", name: "Tracker", qualifiedName: "Tracker" },
      { id: "Tracker::Parts", kind: "package", name: "Parts", qualifiedName: "Tracker::Parts", parentId: "Tracker" },
      {
        id: "Tracker::Parts::lens",
        kind: "part",
        name: "lens",
        qualifiedName: "Tracker::Parts::lens",
        parentId: "Tracker::Parts",
      },
      {
        id: "Tracker::Parts::mount",
        kind: "part",
        name: "mount",
        qualifiedName: "Tracker::Parts::mount",
        parentId: "Tracker::Parts",
      },
      {
        id: "Tracker::'needs focus'",
        kind: "requirement",
        name: "needs focus",
        qualifiedName: "Tracker::'needs focus'",
        parentId: "Tracker",
      },
      { id: "Tracker::'needs focus'::<doc>", kind: "doc", parentId: "Tracker::'needs focus'" },
    ]);
  });

  it("reports per-file provenance in elementDetails", () => {
    const lens = elementDetails(index, workspace, "Tracker::Parts::lens");
    expect(lens?.kind).toBe("part");
    expect(lens?.name).toBe("lens");
    expect(lens?.qualifiedName).toBe("Tracker::Parts::lens");
    expect(lens?.parentChain).toEqual(["Tracker", "Parts"]);
    expect(lens?.declaringFile).toBe("model/mounts.sysml");
    expect(lens?.fields).toEqual([{ key: "type", label: "Type", value: "LensCell" }]);

    const mount = elementDetails(index, workspace, "Tracker::Parts::mount");
    expect(mount?.declaringFile).toBe("model/requirements.sysml");
    expect(mount?.fields).toEqual([{ key: "type", label: "Type", value: "MountCell" }]);
  });

  it("resolves quoted, unquoted and array qualified-name forms to the same element", () => {
    const quoted = elementDetails(index, workspace, "Tracker::'needs focus'");
    const unquoted = elementDetails(index, workspace, "Tracker::needs focus");
    const array = elementDetails(index, workspace, ["Tracker", "needs focus"]);
    expect(unquoted?.id).toBe("Tracker::'needs focus'");
    expect(quoted).toEqual(unquoted);
    expect(array).toEqual(unquoted);
    expect(unquoted?.kind).toBe("requirement");
    expect(unquoted?.parentChain).toEqual(["Tracker"]);
  });

  it("resolves unnamed elements through their synthetic id (byId path)", () => {
    const doc = elementDetails(index, workspace, "Tracker::'needs focus'::<doc>");
    if (doc === undefined) throw new Error("expected doc details");
    expect(doc.id).toBe("Tracker::'needs focus'::<doc>");
    expect(doc.kind).toBe("doc");
    expect("name" in doc).toBe(false);
    expect("qualifiedName" in doc).toBe(false);
    expect(doc.parentChain).toEqual(["Tracker", "needs focus"]);
    expect(doc.fields).toEqual([{ key: "text", label: "Text", value: "must focus" }]);
    expect(doc.owned).toEqual([]);
  });

  it("lists direct members, unnamed included, as owned elements in document order", () => {
    const requirement = elementDetails(index, workspace, "Tracker::'needs focus'");
    expect(requirement?.owned).toEqual([
      { id: "Tracker::'needs focus'::<doc>", kind: "doc", syntheticLabel: "<doc>", preview: "must focus" },
    ]);

    const root = elementDetails(index, workspace, "Tracker");
    expect(root?.owned.map((owned) => owned.id)).toEqual([
      "Tracker::Parts",
      "Tracker::'needs focus'",
    ]);
  });

  it("reports the named kinds only, so all-unnamed kinds offer no filter button", () => {
    expect(namedOutlineKinds(index)).toEqual(["package", "part", "requirement"]);
  });

  it("lists named rows with their nesting depth, unnamed rows excluded", () => {
    expect(namedOutlineRows(index)).toEqual([
      { row: { id: "Tracker", kind: "package", name: "Tracker", qualifiedName: "Tracker" }, depth: 0 },
      {
        row: { id: "Tracker::Parts", kind: "package", name: "Parts", qualifiedName: "Tracker::Parts", parentId: "Tracker" },
        depth: 1,
      },
      {
        row: {
          id: "Tracker::Parts::lens",
          kind: "part",
          name: "lens",
          qualifiedName: "Tracker::Parts::lens",
          parentId: "Tracker::Parts",
        },
        depth: 2,
      },
      {
        row: {
          id: "Tracker::Parts::mount",
          kind: "part",
          name: "mount",
          qualifiedName: "Tracker::Parts::mount",
          parentId: "Tracker::Parts",
        },
        depth: 2,
      },
      {
        row: {
          id: "Tracker::'needs focus'",
          kind: "requirement",
          name: "needs focus",
          qualifiedName: "Tracker::'needs focus'",
          parentId: "Tracker",
        },
        depth: 1,
      },
    ]);
  });

  it("honors the kind filter; depth spans the rows present in the filtered list", () => {
    const filtered = namedOutlineRows(index, { kind: "part" });
    expect(filtered.map(({ row }) => row.id)).toEqual(["Tracker::Parts::lens", "Tracker::Parts::mount"]);
    // The filtered list has no package rows, so the parentId chain resolves
    // only within it: depth 1, not the unfiltered depth 2. (Unnamed rows that
    // PASS the filter — e.g. a doc container between two named ones — do keep
    // the chain intact; that is what the all-rows id map exists for.)
    expect(filtered.map(({ depth }) => depth)).toEqual([1, 1]);
  });
});

describe("index edge cases over a hand-built model", () => {
  // Hand-built fixture fed to the REAL createModelIndex: exercises the real
  // id/quoting/`[n]`-suffix semantics without depending on parser fixtures.
  const model: SysmlModel = {
    kind: "model",
    members: [
      {
        kind: "package",
        name: "Root",
        members: [
          { kind: "doc", text: "first" },
          { kind: "doc", text: "second" },
          { kind: "part", name: "p1", type: "T" },
          { kind: "part", name: "p1", type: "U" },
          { kind: "requirement", name: "needs focus", id: "R-1", text: "must focus" },
          { kind: "import", target: "Root::p1" },
        ],
      },
      { kind: "attribute", name: "attr", value: "42" },
    ],
  };
  const index = createModelIndex({ model });

  it("lists every element in document (DFS pre-order) order", () => {
    expect(outlineRows(index).map((row) => row.id)).toEqual([
      "Root",
      "Root::<doc>",
      "Root::<doc>[2]",
      "Root::p1",
      "Root::p1[2]",
      "Root::'needs focus'",
      "Root::<import>",
      "attr",
    ]);
  });

  it("derives nesting from parentId and leaves top-level rows parentless", () => {
    const rows = outlineRows(index);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("Root")?.parentId).toBeUndefined();
    expect(byId.get("Root::p1")?.parentId).toBe("Root");
    expect(byId.get("Root::<doc>")?.parentId).toBe("Root");
    expect(byId.get("attr")?.parentId).toBeUndefined();
  });

  it("lists unnamed elements with their kind but no name or qualified name", () => {
    const rows = outlineRows(index);
    const docRow = rows.find((row) => row.id === "Root::<doc>");
    if (docRow === undefined) throw new Error("expected the first doc row");
    expect(docRow.kind).toBe("doc");
    expect("name" in docRow).toBe(false);
    expect("qualifiedName" in docRow).toBe(false);

    const importRow = rows.find((row) => row.id === "Root::<import>");
    if (importRow === undefined) throw new Error("expected the import row");
    expect(importRow.kind).toBe("import");
    expect(importRow.parentId).toBe("Root");
    expect("name" in importRow).toBe(false);
    expect("qualifiedName" in importRow).toBe(false);
  });

  it("keeps the index's duplicate-sibling [n] suffixes in ids and qualified names", () => {
    const rows = outlineRows(index);
    const second = rows.find((row) => row.id === "Root::p1[2]");
    expect(second?.qualifiedName).toBe("Root::p1[2]");
    expect(rows.map((row) => row.id)).toContain("Root::<doc>[2]");
  });

  it("filters rows by a single kind or several kinds, first-seen order preserved", () => {
    expect(outlineRows(index, { kind: "part" }).map((row) => row.id)).toEqual(["Root::p1", "Root::p1[2]"]);
    expect(outlineRows(index, { kind: ["doc", "import"] }).map((row) => row.id)).toEqual([
      "Root::<doc>",
      "Root::<doc>[2]",
      "Root::<import>",
    ]);
    expect(outlineRows(index, { kind: "metadata" })).toEqual([]);
  });

  it("reports the distinct kinds of named elements via namedOutlineKinds", () => {
    // doc and import exist in the model but every one of them is unnamed,
    // so they must not surface as filterable kinds.
    expect(namedOutlineKinds(index)).toEqual(["package", "part", "requirement", "attribute"]);
  });

  it("distinguishes duplicate siblings through elementDetails ([n] suffix)", () => {
    const first = elementDetails(index, originStub, "Root::p1");
    const second = elementDetails(index, originStub, "Root::p1[2]");
    expect(first?.id).toBe("Root::p1");
    expect(first?.fields).toEqual([{ key: "type", label: "Type", value: "T" }]);
    expect(second?.id).toBe("Root::p1[2]");
    expect(second?.qualifiedName).toBe("Root::p1[2]");
    expect(second?.fields).toEqual([{ key: "type", label: "Type", value: "U" }]);
    expect(second?.parentChain).toEqual(["Root"]);
  });

  it("extracts curated kind-specific fields from the permissive Member shape", () => {
    const details = elementDetails(index, originStub, "Root::'needs focus'");
    expect(details?.kind).toBe("requirement");
    expect(details?.fields).toEqual([
      { key: "id", label: "Id", value: "R-1" },
      { key: "text", label: "Text", value: "must focus" },
    ]);
  });

  it("lists direct members, unnamed included, as owned elements in document order", () => {
    const details = elementDetails(index, originStub, "Root");
    expect(details?.owned).toEqual([
      { id: "Root::<doc>", kind: "doc", syntheticLabel: "<doc>", preview: "first" },
      { id: "Root::<doc>[2]", kind: "doc", syntheticLabel: "<doc>[2]", preview: "second" },
      { id: "Root::p1", kind: "part", name: "p1" },
      { id: "Root::p1[2]", kind: "part", name: "p1" },
      { id: "Root::'needs focus'", kind: "requirement", name: "needs focus" },
      { id: "Root::<import>", kind: "import", syntheticLabel: "<import>" },
    ]);
  });

  it("previews only the first non-empty doc line, truncated to 80 characters", () => {
    const longModel: SysmlModel = {
      kind: "model",
      members: [
        {
          kind: "package",
          name: "P",
          members: [
            { kind: "doc", text: "\n\n  leading blanks skipped  \nsecond line" },
            {
              kind: "doc",
              text:
                "x".repeat(90),
            },
          ],
        },
      ],
    };
    const longIndex = createModelIndex({ model: longModel });
    const details = elementDetails(longIndex, originStub, "P");
    expect(details?.owned[0]?.preview).toBe("leading blanks skipped");
    expect(details?.owned[1]?.preview).toBe(`${"x".repeat(77)}…`);
    expect(details?.owned[1]?.preview?.length).toBe(78);
  });

  it("renders only known scalar fields and skips unknown shapes", () => {
    const featureModel: SysmlModel = {
      kind: "model",
      members: [
        {
          kind: "feature",
          name: "f1",
          direction: "in",
          type: "T",
          multiplicity: "1..*",
          value: ["a", "b"],
          config: { nested: true },
          members: [
            { kind: "feature", name: "inner", type: "U" },
          ],
        },
      ],
    };
    const featureIndex = createModelIndex({ model: featureModel });
    const details = elementDetails(featureIndex, originStub, "f1");
    expect(details?.fields).toEqual([
      { key: "type", label: "Type", value: "T" },
      { key: "direction", label: "Direction", value: "in" },
      { key: "multiplicity", label: "Multiplicity", value: "1..*" },
      { key: "value", label: "Value", value: "a, b" },
    ]);
  });

  it("serializes metadata property lists as key = value pairs", () => {
    const metadataModel: SysmlModel = {
      kind: "model",
      members: [
        {
          kind: "metadata",
          syntax: "metadata",
          name: "m1",
          properties: [
            { key: "ver", value: "1.0" },
            { key: "author", value: "kai" },
          ],
        },
      ],
    };
    const metadataIndex = createModelIndex({ model: metadataModel });
    const details = elementDetails(metadataIndex, originStub, "m1");
    expect(details?.fields).toEqual([
      { key: "properties", label: "Properties", value: "ver = 1.0; author = kai" },
    ]);
  });

  it("walks the full parent chain to the root", () => {
    const deepModel: SysmlModel = {
      kind: "model",
      members: [
        {
          kind: "package",
          name: "A",
          members: [
            { kind: "package", name: "B", members: [{ kind: "item", name: "deep", type: "T" }] },
          ],
        },
      ],
    };
    const deepIndex = createModelIndex({ model: deepModel });
    const details = elementDetails(deepIndex, originStub, "A::B::deep");
    expect(details?.kind).toBe("item");
    expect(details?.parentChain).toEqual(["A", "B"]);
    expect(details?.qualifiedName).toBe("A::B::deep");
  });

  it("returns undefined on get() misses and empty input", () => {
    // "Root::<doc>" is NOT a miss anymore: unnamed elements resolve via byId.
    for (const miss of ["Root::nope", "Root::p1::child", "", "attr::x"]) {
      expect(elementDetails(index, originStub, miss)).toBeUndefined();
    }
    expect(elementDetails(index, originStub, ["Root", "nope"])).toBeUndefined();
  });
});

describe("injected index seam (pure over the ModelIndex surface)", () => {
  // A literal fake index: proves outlineRows/elementDetails only depend on
  // list/get/byId/children/kinds and never touch the bundle runtime.
  function fakeIndex(elements: ModelElement[]): ModelIndex {
    return {
      list(filter?: ElementFilter): ModelElement[] {
        if (filter?.kind === undefined) return [...elements];
        const kinds = Array.isArray(filter.kind) ? filter.kind : [filter.kind];
        return elements.filter((element) => kinds.includes(element.kind));
      },
      get(qualifiedName: string | string[]): ModelElement | undefined {
        const key = Array.isArray(qualifiedName) ? qualifiedName.join("::") : qualifiedName;
        return elements.find((element) => element.id === key);
      },
      byId(id: string): ModelElement | undefined {
        return elements.find((element) => element.id === id);
      },
      children(parentId: string | undefined): ModelElement[] {
        return elements.filter((element) => element.parentId === parentId);
      },
      kinds(): Member["kind"][] {
        const kinds: Member["kind"][] = [];
        const seen = new Set<Member["kind"]>();
        for (const element of elements) {
          if (!seen.has(element.kind)) {
            seen.add(element.kind);
            kinds.push(element.kind);
          }
        }
        return kinds;
      },
    };
  }

  const elements: ModelElement[] = [
    { id: "Pkg", kind: "package", name: "Pkg", qualifiedName: "Pkg", member: { kind: "package", name: "Pkg" } },
    { id: "Pkg::<doc>", kind: "doc", parentId: "Pkg", member: { kind: "doc", text: "x" } },
    {
      id: "Pkg::p",
      kind: "part",
      name: "p",
      qualifiedName: "Pkg::p",
      parentId: "Pkg",
      member: { kind: "part", name: "p", type: "T" },
    },
  ];
  const index = fakeIndex(elements);

  it("maps list() output to rows and forwards the kind filter", () => {
    expect(outlineRows(index)).toEqual([
      { id: "Pkg", kind: "package", name: "Pkg", qualifiedName: "Pkg" },
      { id: "Pkg::<doc>", kind: "doc", parentId: "Pkg" },
      { id: "Pkg::p", kind: "part", name: "p", qualifiedName: "Pkg::p", parentId: "Pkg" },
    ]);
    expect(outlineRows(index, { kind: "doc" })).toEqual([{ id: "Pkg::<doc>", kind: "doc", parentId: "Pkg" }]);
    expect(namedOutlineKinds(index)).toEqual(["package", "part"]);
  });

  it("resolves details through the injected get() and originOf", () => {
    const details = elementDetails(
      index,
      { originOf: (member) => (member.kind === "part" ? "model/p.sysml" : undefined) },
      "Pkg::p",
    );
    expect(details).toBeDefined();
    expect(details?.id).toBe("Pkg::p");
    expect(details?.kind).toBe("part");
    expect(details?.parentChain).toEqual(["Pkg"]);
    expect(details?.declaringFile).toBe("model/p.sysml");
    expect(details?.fields).toEqual([{ key: "type", label: "Type", value: "T" }]);
    // p is a leaf: no owned members.
    expect(details?.owned).toEqual([]);
  });

  it("resolves unnamed details through the injected byId and children", () => {
    const details = elementDetails(index, originStub, "Pkg");
    expect(details?.owned).toEqual([
      { id: "Pkg::<doc>", kind: "doc", syntheticLabel: "<doc>", preview: "x" },
      { id: "Pkg::p", kind: "part", name: "p" },
    ]);

    const doc = elementDetails(index, originStub, "Pkg::<doc>");
    expect(doc?.id).toBe("Pkg::<doc>");
    expect(doc?.kind).toBe("doc");
    expect(doc?.fields).toEqual([{ key: "text", label: "Text", value: "x" }]);
    expect(doc?.parentChain).toEqual(["Pkg"]);
  });

  it("resolves details through a stub workspace with no provenance", () => {
    const details = elementDetails(index, originStub, "Pkg::p");
    if (details === undefined) throw new Error("expected details");
    expect(details.declaringFile).toBeUndefined();
    expect("declaringFile" in details).toBe(false);
  });
});