// @vitest-environment happy-dom
//
// Preference unit tests (plan-v5 §2.C1/D1): the `.sysml` chat-link claim is
// a localStorage preference with a default-on fail-safe — absent, junk,
// storage-less, and throwing (SecurityError) reads all behave as "on",
// and only the explicit "0" opts out. happy-dom supplies a real
// localStorage; the storage-less and throwing-storage branches are driven
// through `vi.stubGlobal`, restored in afterEach (`vi.unstubAllGlobals`).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openseClaimsSysmlLinks, setOpenseClaimsSysmlLinks } from "./opense-preferences.js";

const CLAIM_SYSML_LINKS_KEY = "opense.claimSysmlLinks";

beforeEach(() => {
  localStorage.removeItem(CLAIM_SYSML_LINKS_KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem(CLAIM_SYSML_LINKS_KEY);
});

describe("openseClaimsSysmlLinks (C1 localStorage preference)", () => {
  it("defaults to claiming when the key is absent", () => {
    expect(openseClaimsSysmlLinks()).toBe(true);
  });

  it("returns false only for the explicit off value", () => {
    localStorage.setItem(CLAIM_SYSML_LINKS_KEY, "0");
    expect(openseClaimsSysmlLinks()).toBe(false);
  });

  it("returns true for the explicit on value", () => {
    localStorage.setItem(CLAIM_SYSML_LINKS_KEY, "1");
    expect(openseClaimsSysmlLinks()).toBe(true);
  });

  it("returns true for unrecognized junk values", () => {
    localStorage.setItem(CLAIM_SYSML_LINKS_KEY, "maybe");
    expect(openseClaimsSysmlLinks()).toBe(true);
  });

  it("writes 1/0 through the setter and round-trips through the getter", () => {
    setOpenseClaimsSysmlLinks(false);
    expect(localStorage.getItem(CLAIM_SYSML_LINKS_KEY)).toBe("0");
    expect(openseClaimsSysmlLinks()).toBe(false);

    setOpenseClaimsSysmlLinks(true);
    expect(localStorage.getItem(CLAIM_SYSML_LINKS_KEY)).toBe("1");
    expect(openseClaimsSysmlLinks()).toBe(true);
  });

  it("degrades to the default without localStorage and never throws", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(openseClaimsSysmlLinks()).toBe(true);
    expect(() => setOpenseClaimsSysmlLinks(false)).not.toThrow();
  });

  it("degrades to the default when storage access throws (SecurityError)", () => {
    // Blocked cookies / legacy Safari private mode: `typeof localStorage`
    // is fine, yet every access throws — the guarded accessors must
    // degrade instead (read → default, write → no-op).
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(openseClaimsSysmlLinks()).toBe(true);
    expect(() => setOpenseClaimsSysmlLinks(false)).not.toThrow();
  });
});