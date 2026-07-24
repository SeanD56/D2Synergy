import { describe, expect, it } from "vitest";

import { createLookup, type Lookup } from "@/lib/validation";
import { loadDataset } from "@/lib/data";

// Known weapon trait perks that MUST resolve via the name bridge with these tags.
// If a season re-ingest drops a tag or renames a perk, this fails loudly.
const CURATED: Array<[string, "produces" | "consumes" | "triggers", string]> = [
  ["Voltshot", "produces", "jolt"],
  ["Incandescent", "produces", "scorch"],
  ["Destabilizing Rounds", "produces", "volatile"],
  ["Repulsor Brace", "produces", "overshield"],
  ["Firefly", "triggers", "precision_kill"],
];

describe("weapon plug-name bridge — curated resolution (real data)", () => {
  let lookup: Lookup;
  it("loads", async () => { lookup = createLookup(await loadDataset()); });

  for (const [name, bucket, keyword] of CURATED) {
    it(`${name} resolves to ${bucket}:${keyword}`, () => {
      const p = lookup.perkByName(name);
      expect(p, `${name} must resolve`).toBeDefined();
      expect(p!.tags[bucket]).toContain(keyword);
    });
  }
});
