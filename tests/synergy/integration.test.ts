import { existsSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import type { Build, DerivedDataset, Fragment } from "@/lib/types";
import { createLookup, validateBuild, type Lookup } from "@/lib/validation";
import { allRules, scoreSynergy } from "@/lib/synergy";

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));

const emptyBuild = (): Build => ({
  subclass: { aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
});

describe.runIf(hasDataset)("synergy engine (integration)", () => {
  let ds: DerivedDataset;
  let lookup: Lookup;

  beforeAll(async () => {
    ds = await loadDataset();
    lookup = createLookup(ds);
  });

  it("scores a real producer→consumer fragment pair above zero with a why", () => {
    // Find any keyword one fragment produces and a DIFFERENT fragment consumes.
    let found: { p: Fragment; c: Fragment; kw: string } | undefined;
    for (const p of ds.fragments) {
      for (const kw of p.tags.produces) {
        const c = ds.fragments.find(
          (f) => f.hash !== p.hash && f.tags.consumes.includes(kw),
        );
        if (c) {
          found = { p, c, kw };
          break;
        }
      }
      if (found) break;
    }
    expect(found, "expected a producer/consumer fragment pair in the dataset").toBeTruthy();

    const build: Build = {
      ...emptyBuild(),
      subclass: {
        element: found!.p.element,
        aspectHashes: [],
        fragmentHashes: [found!.p.hash, found!.c.hash],
      },
    };
    const result = scoreSynergy(build, lookup);
    expect(result.score).toBeGreaterThan(0);
    expect(result.synergies.some((s) => s.via === found!.kw)).toBe(true);
    expect(result.synergies[0].why.length).toBeGreaterThan(0);
  });

  it("emits an unused-producer advisory without invalidating", () => {
    // A mod that produces a keyword it does NOT itself consume, placed in armor
    // (which trips no hard-rule floors), so the build is game-valid while the
    // produced keyword has no consumer → advisory only.
    const pureProducerMod = ds.mods.find((m) =>
      m.tags.produces.some((k) => !m.tags.consumes.includes(k)),
    );
    expect(pureProducerMod, "expected a non-self-consuming producer mod").toBeTruthy();
    const build: Build = {
      ...emptyBuild(),
      armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [pureProducerMod!.hash] },
    };
    const result = validateBuild(build, lookup, allRules);
    expect(result.valid).toBe(true); // policy advisories never invalidate
    expect(result.violations.some((v) => v.code === "UNUSED_PRODUCER")).toBe(true);
  });
});
