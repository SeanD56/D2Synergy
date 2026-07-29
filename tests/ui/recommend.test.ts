import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  GUARDIAN_CLASSES, parseClassType, parseElement, recommend, SUBCLASS_ELEMENTS,
} from "@/lib/ui/recommend";

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));

/**
 * The UI's solver entry point. Kept out of the page component precisely so it can be tested
 * without rendering, and so the page stays thin.
 */

describe("query-string narrowing", () => {
  // These parse UNTRUSTED input from the URL, so they must reject rather than coerce.
  it("accepts every pinnable element and rejects anything else", () => {
    for (const e of SUBCLASS_ELEMENTS) expect(parseElement(e)).toBe(e);
    expect(parseElement("kinetic")).toBeUndefined(); // a real Element, but not a SUBCLASS element
    expect(parseElement("ARC")).toBeUndefined(); // case-sensitive on purpose
    expect(parseElement(undefined)).toBeUndefined();
    expect(parseElement("")).toBeUndefined();
  });

  it("accepts the three classes and rejects 'any'", () => {
    for (const c of GUARDIAN_CLASSES) expect(parseClassType(c)).toBe(c);
    // "any" is a valid GuardianClass but matches no exotic, and would surface as a silent
    // feasible:false — so it must never come through the URL.
    expect(parseClassType("any")).toBeUndefined();
    expect(parseClassType("wizard")).toBeUndefined();
  });

  it("takes the first value when a param repeats", () => {
    expect(parseElement(["void", "arc"])).toBe("void");
    expect(parseClassType(["titan", "hunter"])).toBe("titan");
  });
});

describe.runIf(hasDataset)("recommend — against the real dataset", () => {
  it("solves an element-only pin and reports the current artifact", async () => {
    const { result, artifactName, elapsedMs } = await recommend({ element: "arc" });
    expect(result.feasible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.builds.length).toBeGreaterThan(0);
    // The artifact must come from the CURRENT-season resolution, not an arbitrary pick.
    expect(artifactName).toBe("Implement of Curiosity");
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it("opens the exotic and aspect dimensions when a class is pinned", async () => {
    // classType is what opens both dimensions, so pinning it must change the OUTPUT, not just
    // the inputs — otherwise the wiring is inert.
    const withoutClass = await recommend({ element: "arc" });
    const withClass = await recommend({ element: "arc", classType: "warlock" });

    expect(withClass.result.builds[0].build.armor.exoticHash).toBeDefined();
    expect(withoutClass.result.builds[0].build.armor.exoticHash).toBeUndefined();
    expect(withClass.result.builds[0].build.subclass.aspectHashes).toHaveLength(2);
    expect(withoutClass.result.builds[0].build.subclass.aspectHashes).toHaveLength(0);
  }, 120_000);

  it("solves every element, so no element is a dead end in the UI", async () => {
    // Stasis is the point of this test: it had NO aspects or fragments in the dataset until the
    // ingest repair, so a Stasis pin used to be silently infeasible.
    for (const element of SUBCLASS_ELEMENTS) {
      const { result } = await recommend({ element, classType: "warlock" });
      expect(result.feasible, `${element}: ${JSON.stringify(result.reasons)}`).toBe(true);
      expect(result.builds.length, element).toBeGreaterThan(0);
    }
  }, 300_000);

  it("leaves mods alone unless asked", async () => {
    const { result } = await recommend({ element: "arc", classType: "warlock" });
    expect(result.builds[0].build.armor.modHashes).toEqual([]);
  }, 120_000);
});
