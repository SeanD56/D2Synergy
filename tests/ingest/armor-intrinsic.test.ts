import { describe, expect, it } from "vitest";

import { createClassifier } from "../../scripts/ingest/classify";
import { createKeywordTagger } from "../../scripts/ingest/keywords";
import { transformAll } from "../../scripts/ingest/transform";

import {
  H,
  exoticHelmetItem,
  exoticIntrinsicPlug,
  legendaryHelmetItem,
  makeSlice,
} from "./fixtures";

/** Run the transform over a slice containing both helmets + one sandbox perk. */
function runWith(perkDescription: string) {
  const slice = makeSlice({
    items: {
      [H.exoticHelmet]: exoticHelmetItem,
      [H.intrinsicPlug]: exoticIntrinsicPlug,
      [H.legendaryHelmet]: legendaryHelmetItem,
    },
    sandboxPerks: {
      [H.intrinsicSandboxPerk]: {
        hash: H.intrinsicSandboxPerk,
        displayProperties: { description: perkDescription },
      },
    },
  });
  return transformAll(slice, createClassifier(slice), createKeywordTagger());
}

describe("exotic armor intrinsic extraction", () => {
  it("tags an exotic from its intrinsic socket's sandbox-perk text", () => {
    const armor = runWith("Grants restoration to nearby allies.").armor;
    const exotic = armor.find((a) => a.hash === H.exoticHelmet);
    expect(exotic).toBeDefined();
    expect(exotic!.tier).toBe("exotic");
    expect(exotic!.tags.produces).toContain("restoration");
  });

  it("populates exoticPerkHash from the intrinsic plug, not the empty item.perks", () => {
    const exotic = runWith("Grants restoration.").armor.find((a) => a.hash === H.exoticHelmet)!;
    expect(exotic.exoticPerkHash).toBe(H.intrinsicSandboxPerk);
  });

  it("unions intrinsic text with the item's own flavor text", () => {
    // Flavor text on the fixture says nothing tag-worthy; the intrinsic says jolt.
    const exotic = runWith("Final blows jolt nearby targets.").armor
      .find((a) => a.hash === H.exoticHelmet)!;
    expect(exotic.tags.produces).toContain("jolt");
  });

  it("leaves non-exotics untouched (tags still come from their own text)", () => {
    const legendary = runWith("Grants restoration.").armor
      .find((a) => a.hash === H.legendaryHelmet)!;
    expect(legendary.tier).toBe("legendary");
    expect(legendary.tags.produces).toContain("woven_mail");
    expect(legendary.tags.produces).not.toContain("restoration");
    expect(legendary.exoticPerkHash).toBeUndefined();
  });

  it("still records the mod socket layout", () => {
    const exotic = runWith("Grants restoration.").armor.find((a) => a.hash === H.exoticHelmet)!;
    expect(exotic.modSocketHashes).toEqual([H.modSocketType]);
  });
});
