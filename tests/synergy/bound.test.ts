import { describe, expect, it } from "vitest";

import { EMPTY_TAGS, type Build } from "@/lib/types";
import type { Lookup } from "@/lib/validation/types";
import type { BuildElement } from "@/lib/synergy/types";
import { scoreSynergy } from "@/lib/synergy/score";
import { synergyUpperBound } from "@/lib/synergy/bound";

const tags = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });

// Fragments 200/201/202 + artifact perks 400/401 form a small reachable universe.
const FRAGS: Record<number, { name: string; tags: typeof EMPTY_TAGS }> = {
  200: { name: "Prod", tags: tags({ produces: ["ignite", "surge"], element: "solar" }) },
  201: { name: "Flare", tags: tags({ produces: ["flare"], element: "solar" }) },
  202: { name: "Inert", tags: EMPTY_TAGS },
};
const PERKS: Record<number, { name: string; tags: typeof EMPTY_TAGS }> = {
  400: { name: "Ign", tags: tags({ consumes: ["ignite"] }) },
  401: { name: "Sur", tags: tags({ consumes: ["surge"] }) },
};

const lookup = {
  aspect: (h: number) =>
    h === 100 ? { hash: 100, name: "Asp", tags: tags({ consumes: ["flare"], element: "solar" }) } : undefined,
  fragment: (h: number) => (FRAGS[h] ? { hash: h, element: "solar", ...FRAGS[h] } : undefined),
  artifactPerk: (h: number) => (PERKS[h] ? { hash: h, ...PERKS[h] } : undefined),
} as unknown as Lookup;

const el = (hash: number, source: string, t: typeof EMPTY_TAGS): BuildElement => ({ hash, source, tags: t });

const present: Build = {
  subclass: { element: "solar", aspectHashes: [100], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
};

// Every element that could still be added to `present`.
const addable: BuildElement[] = [
  el(200, "fragment:Prod", FRAGS[200].tags),
  el(201, "fragment:Flare", FRAGS[201].tags),
  el(202, "fragment:Inert", EMPTY_TAGS),
  el(400, "artifact-perk:Ign", PERKS[400].tags),
  el(401, "artifact-perk:Sur", PERKS[401].tags),
];

describe("synergyUpperBound", () => {
  it("dominates scoreSynergy over every reachable completion (admissible)", () => {
    const bound = synergyUpperBound(present, addable, lookup);
    // Enumerate all subsets of the addable fragments/perks and score each build.
    const fragHashes = [200, 201, 202];
    const perkHashes = [400, 401];
    for (let f = 0; f < 1 << fragHashes.length; f++) {
      for (let p = 0; p < 1 << perkHashes.length; p++) {
        const frags = fragHashes.filter((_, i) => f & (1 << i));
        const perks = perkHashes.filter((_, i) => p & (1 << i));
        const build: Build = {
          ...present,
          subclass: { ...present.subclass, fragmentHashes: frags },
          artifact: { selectedPerkHashes: perks },
        };
        expect(scoreSynergy(build, lookup).score).toBeLessThanOrEqual(bound + 1e-9);
      }
    }
  });

  it("credits a producer's future chain only when a consumer is reachable", () => {
    // Producer present, its consumer reachable → bound > 0.
    const withConsumer = synergyUpperBound(present, [el(200, "f", FRAGS[200].tags), el(400, "p", PERKS[400].tags)], lookup);
    expect(withConsumer).toBeGreaterThan(0);
    // Producer reachable, NO consumer anywhere → bound stays 0.
    const noConsumer = synergyUpperBound(present, [el(200, "f", tags({ produces: ["ignite"] }))], lookup);
    expect(noConsumer).toBe(0);
  });
});

describe("synergyUpperBound — multi-pair chains and trigger groups", () => {
  // Keyword "spark" has TWO producers (500,501) and TWO consumers (502,503) →
  // the bound must cover triangular(2) = ranks 1+2. Three of them share the
  // trigger "grenade" → the (capped) trigger term must be covered too.
  const SPARK: Record<number, { name: string; tags: typeof EMPTY_TAGS }> = {
    500: { name: "P1", tags: tags({ produces: ["spark"], triggers: ["grenade"], element: "solar" }) },
    501: { name: "P2", tags: tags({ produces: ["spark"], triggers: ["grenade"], element: "solar" }) },
    502: { name: "C1", tags: tags({ consumes: ["spark"], triggers: ["grenade"], element: "solar" }) },
    503: { name: "C2", tags: tags({ consumes: ["spark"], element: "solar" }) },
  };
  const lk = {
    aspect: () => undefined,
    fragment: (h: number) => (SPARK[h] ? { hash: h, element: "solar", ...SPARK[h] } : undefined),
    artifactPerk: () => undefined,
  } as unknown as Lookup;
  const base: Build = {
    subclass: { element: "solar", aspectHashes: [], fragmentHashes: [] },
    weapons: [],
    armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
    artifact: { selectedPerkHashes: [] },
    constraints: [],
  };
  const reach: BuildElement[] = [500, 501, 502, 503].map((h) => el(h, `fragment:${SPARK[h].name}`, SPARK[h].tags));

  it("dominates scoreSynergy over every subset, exercising rank≥2 chains and the trigger term", () => {
    const bound = synergyUpperBound(base, reach, lk);
    const hashes = [500, 501, 502, 503];
    let sawTwoPairs = false;
    for (let m = 0; m < 1 << hashes.length; m++) {
      const frags = hashes.filter((_, i) => m & (1 << i));
      const build: Build = { ...base, subclass: { ...base.subclass, fragmentHashes: frags } };
      const s = scoreSynergy(build, lk);
      expect(s.score).toBeLessThanOrEqual(bound + 1e-9);
      if (frags.length === 4) sawTwoPairs = s.synergies.filter((x) => x.via === "spark").length === 2;
    }
    // The rank≥2 chain path (two matched "spark" links) was actually realized.
    expect(sawTwoPairs).toBe(true);
    // The trigger path fires in a scored build and the bound still dominates it.
    const full: Build = { ...base, subclass: { ...base.subclass, fragmentHashes: [500, 501, 502, 503] } };
    const fullScore = scoreSynergy(full, lk);
    expect(fullScore.synergies.some((x) => x.via === "trigger:grenade")).toBe(true);
    expect(fullScore.score).toBeLessThanOrEqual(bound + 1e-9);
  });
});
