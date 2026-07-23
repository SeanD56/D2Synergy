import { existsSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import type { Build, DerivedDataset } from "@/lib/types";
import { createLookup, validateBuild, type Lookup } from "@/lib/validation";

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));

describe.runIf(hasDataset)("validateBuild (integration)", () => {
  let ds: DerivedDataset;
  let lookup: Lookup;

  beforeAll(async () => {
    ds = await loadDataset();
    lookup = createLookup(ds);
  });

  /** Build a minimal legal artifact loadout: fill 2/3/2 with distinct perks. */
  function fullArtifact(): Build["artifact"] {
    const artifact = ds.artifacts[0];
    const selectedPerkHashes = artifact.tiers.flatMap((t) =>
      t.perks.slice(0, t.slots).map((p) => p.hash),
    );
    return { artifactHash: artifact.hash, selectedPerkHashes };
  }

  it("passes a legal artifact selection", () => {
    const build: Build = {
      subclass: { aspectHashes: [], fragmentHashes: [] },
      weapons: [],
      armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
      artifact: fullArtifact(),
      constraints: [],
    };
    const result = validateBuild(build, lookup);
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("flags an over-capped artifact tier", () => {
    const artifact = ds.artifacts[0];
    // Take 3 perks from tier 0 (slots=2) → over cap; plus fill others to isolate the code.
    const t0 = artifact.tiers[0];
    const selectedPerkHashes = [
      ...t0.perks.slice(0, 3).map((p) => p.hash),
      ...artifact.tiers[1].perks.slice(0, artifact.tiers[1].slots).map((p) => p.hash),
      ...artifact.tiers[2].perks.slice(0, artifact.tiers[2].slots).map((p) => p.hash),
    ];
    const build: Build = {
      subclass: { aspectHashes: [], fragmentHashes: [] },
      weapons: [],
      armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
      artifact: { artifactHash: artifact.hash, selectedPerkHashes },
      constraints: [],
    };
    const result = validateBuild(build, lookup);
    expect(result.valid).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("ARTIFACT_TIER_OVER_CAP");
  });
});
