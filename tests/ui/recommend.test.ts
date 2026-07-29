import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import { ASPECT_CAP } from "@/lib/solver/subclass";
import type { Build, DerivedDataset } from "@/lib/types";
import { createLookup } from "@/lib/validation";

import {
  GUARDIAN_CLASSES, parseClassType, parseElement, recommend, resolveDisplay, SUBCLASS_ELEMENTS,
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

/**
 * Display resolution. The page renders EXCLUSIVELY from `BuildDisplay`, so these assertions cover
 * the whole build summary — that is what makes the "no bare hash" test below meaningful rather
 * than a check on one field the page might not even use.
 *
 * Expected names are derived by scanning the dataset ARRAYS, while `recommend` resolves through
 * the `Lookup` hash maps. Two independent paths, so agreement means the RIGHT entity was resolved
 * — not merely that some name was produced.
 */
describe.runIf(hasDataset)("recommend — resolved display names", () => {
  it("names every entity the solver chose, in the order it chose them", async () => {
    const { result, displays } = await recommend({ element: "arc", classType: "warlock" });
    const ds = await loadDataset();
    const { build } = result.builds[0];
    const display = displays[0];

    const nameOf = <T extends { hash: number; name: string }>(pool: T[], hash: number) =>
      pool.find((e) => e.hash === hash)?.name;

    expect(display.exoticName).toBe(ds.armor.find((a) => a.hash === build.armor.exoticHash)?.name);
    expect(display.exoticName).toMatch(/\S/);

    expect(display.aspectNames).toHaveLength(ASPECT_CAP);
    expect(display.aspectNames)
      .toEqual(build.subclass.aspectHashes.map((h) => nameOf(ds.aspects, h)));

    expect(display.fragmentNames.length).toBeGreaterThan(0);
    expect(display.fragmentNames)
      .toEqual(build.subclass.fragmentHashes.map((h) => nameOf(ds.fragments, h)));

    const perks = ds.artifacts.flatMap((a) => a.tiers.flatMap((t) => t.perks));
    expect(display.artifactPerkNames.length).toBeGreaterThan(0);
    expect(display.artifactPerkNames)
      .toEqual(build.artifact.selectedPerkHashes.map((h) => nameOf(perks, h)));
  }, 120_000);

  it("puts no bare hash in any displayed value", async () => {
    // The assertion that catches the state this task started from: adding names while leaving a
    // hash rendered somewhere would otherwise pass every test above. Flattens the whole display
    // object so a field added later is covered without editing this test.
    const { displays } = await recommend({ element: "arc", classType: "warlock" });
    const values = Object.values(displays[0]).flat().filter((v) => typeof v === "string");

    expect(values.length).toBeGreaterThan(0); // else this passes vacuously
    for (const value of values) expect(value).not.toMatch(/^\d{4,}$/);
  }, 120_000);

  it("returns one display per ranked build", async () => {
    // The page indexes displays by rank; resolving only the top build would desynchronise them.
    const { result, displays } = await recommend({ element: "arc", classType: "warlock" });
    expect(displays).toHaveLength(result.builds.length);
  }, 120_000);

  it("leaves closed dimensions unnamed rather than inventing a name", async () => {
    // No class pinned ⇒ the exotic and aspect dimensions are CLOSED, so there is nothing to name.
    const { displays } = await recommend({ element: "arc" });
    expect(displays[0].exoticName).toBeUndefined();
    expect(displays[0].aspectNames).toEqual([]);
  }, 120_000);
});

describe("resolveDisplay — a hash that does not resolve", () => {
  it("throws naming the hash instead of falling back to displaying it", () => {
    // Resolution is total by construction: every hash in a solved build came from a pool derived
    // through this same Lookup. So a miss is a defect, and the honest response is to fail loudly
    // rather than print a digit string the user cannot act on.
    const dataset = {
      meta: { ingestedAt: "", manifestVersion: "", counts: {} },
      subclasses: [], aspects: [], fragments: [], weapons: [], armor: [],
      armorSets: [], mods: [], artifacts: [], perks: [], stats: [],
      indexes: {
        keyword: { producers: {}, consumers: {} },
        perkToWeapons: {}, elementToItems: {}, setToPieces: {},
        exoticToClassSlot: {}, slotToWeapons: {},
      },
    } as unknown as DerivedDataset;
    const build = {
      subclass: { element: "arc", aspectHashes: [7777], fragmentHashes: [] },
      weapons: [],
      armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
      artifact: { selectedPerkHashes: [] },
      constraints: [],
    } as unknown as Build;

    expect(() => resolveDisplay(build, createLookup(dataset))).toThrow(/7777/);
  });
});
