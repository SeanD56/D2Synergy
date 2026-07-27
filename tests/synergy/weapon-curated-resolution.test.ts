import { beforeAll, describe, expect, it } from "vitest";

import { createLookup, type Lookup } from "@/lib/validation";
import { loadDataset } from "@/lib/data";
import type { DerivedDataset } from "@/lib/types";

// Known weapon trait perks that MUST resolve with these tags. Since slice 2a the primary
// route is the plug-hash side table (data/plug-tags.json); the plug-NAME bridge remains as
// a fallback for datasets emitted before the table existed. If a season re-ingest drops a
// tag or renames a perk, this fails loudly.
const CURATED: Array<[string, "produces" | "consumes" | "triggers", string]> = [
  ["Voltshot", "produces", "jolt"],
  ["Incandescent", "produces", "scorch"],
  ["Destabilizing Rounds", "produces", "volatile"],
  ["Repulsor Brace", "produces", "overshield"],
  ["Firefly", "triggers", "precision_kill"],
];

describe("weapon plug tag resolution — curated (real data)", () => {
  let ds: DerivedDataset;
  let lookup: Lookup;

  beforeAll(async () => {
    ds = await loadDataset();
    lookup = createLookup(ds);
  });

  for (const [name, bucket, keyword] of CURATED) {
    it(`${name} resolves to ${bucket}:${keyword} by plug hash`, () => {
      // Find the plug by name in the real weapon corpus, then resolve its TAGS BY HASH.
      const plug = ds.weapons
        .flatMap((w) => w.perkColumns.flatMap((c) => c.plugs))
        .find((p) => p.name === name);
      expect(plug, `${name} must exist as a weapon plug`).toBeDefined();
      const tags = lookup.plugTags(plug!.hash) ?? lookup.perkByName(name)?.tags;
      expect(tags, `${name} must resolve tags`).toBeDefined();
      expect(tags![bucket]).toContain(keyword);
    });
  }

  it("resolves the curated plugs through the side table, not only the fallback", () => {
    // The point of slice 2a: these must be present in plug-tags.json by hash. Without this
    // the suite would still pass on the name bridge alone and the side table could silently
    // be empty — the exact failure mode the contract tests exist to catch.
    const plugs = ds.weapons.flatMap((w) => w.perkColumns.flatMap((c) => c.plugs));
    const viaSideTable = CURATED.filter(([name]) => {
      const plug = plugs.find((p) => p.name === name);
      return plug !== undefined && lookup.plugTags(plug.hash) !== undefined;
    });
    expect(viaSideTable.map(([n]) => n)).toEqual(CURATED.map(([n]) => n));
  });
});
