import { describe, expect, it } from "vitest";

import { createClassifier } from "../../scripts/ingest/classify";
import { createKeywordTagger } from "../../scripts/ingest/keywords";
import { transformAll } from "../../scripts/ingest/transform";

import {
  H,
  exoticHelmetItem,
  exoticTraitPlugDef,
  genericModPlug,
  genericStatPlug,
  legendaryHelmetItem,
  makeSlice,
  namelessPlug,
} from "./fixtures";

/**
 * Run the transform over a slice containing both helmets, the exotic's trait plug, and the
 * three ARMOR PERKS decoys (generic stat plug behind a plug set, a nameless plug, and a
 * named-but-perk-less generic mod). Every decoy's text says "volatile", so a discriminator
 * regression shows up as a stray `volatile` tag rather than as silence.
 */
function runWith(perkDescription: string) {
  const slice = makeSlice({
    items: {
      [H.exoticHelmet]: exoticHelmetItem,
      [H.traitPlug]: exoticTraitPlugDef,
      [H.genericStatPlug]: genericStatPlug,
      [H.namelessPlug]: namelessPlug,
      [H.genericModPlug]: genericModPlug,
      [H.legendaryHelmet]: legendaryHelmetItem,
    },
    sandboxPerks: {
      [H.traitSandboxPerk]: {
        hash: H.traitSandboxPerk,
        displayProperties: { description: perkDescription },
      },
      [H.decoySandboxPerk]: {
        hash: H.decoySandboxPerk,
        displayProperties: { description: "Makes targets volatile." },
      },
    },
  });
  return transformAll(slice, createClassifier(slice), createKeywordTagger());
}

const exoticFrom = (perkDescription: string) =>
  runWith(perkDescription).armor.find((a) => a.hash === H.exoticHelmet)!;

describe("exotic armor trait extraction", () => {
  it("tags an exotic from its ARMOR PERKS trait plug's sandbox-perk text", () => {
    const exotic = exoticFrom("Grants restoration to nearby allies.");
    expect(exotic).toBeDefined();
    expect(exotic.tier).toBe("exotic");
    expect(exotic.tags.produces).toContain("restoration");
  });

  it("populates exoticPerkHash from the trait plug, not the empty item.perks", () => {
    expect(exoticFrom("Grants restoration.").exoticPerkHash).toBe(H.traitSandboxPerk);
  });

  it("unions trait text with the item's own flavor text", () => {
    // Flavor text on the fixture says nothing tag-worthy; the trait says jolt.
    expect(exoticFrom("Final blows jolt nearby targets.").tags.produces).toContain("jolt");
  });

  // The three discriminators. Every decoy sits AFTER the trait in socket order and carries
  // "volatile" text plus its own sandbox perk, so if a decoy wrongly qualifies it OUTRANKS
  // the trait under last-match selection — making each assertion below load-bearing. Verified
  // by mutation: removing any single check turns one of these red.
  it("ignores named-but-perk-less generic mods (the 'Special Ammo Finder' case)", () => {
    // Socket [1] is named and carries tag-worthy text, so ONLY the sandbox-perk requirement
    // rejects it. Without that check the rule picks a mod and the real trait is lost — exactly
    // what happened to legacy-shape exotics like Ophidian Aspect.
    const exotic = exoticFrom("Grants restoration.");
    expect(exotic.exoticPerkHash).toBe(H.traitSandboxPerk);
    expect(exotic.tags.produces).not.toContain("volatile");
  });

  it("ignores generic stat plugs reached through a plug set", () => {
    // Socket [2] would fully qualify (named + sandbox perk) if plug sets were followed;
    // only the singleInitialItemHash requirement excludes it.
    const exotic = exoticFrom("Grants restoration.");
    expect(exotic.exoticPerkHash).toBe(H.traitSandboxPerk);
    expect(exotic.tags.produces).not.toContain("volatile");
  });

  it("ignores nameless placeholder plugs", () => {
    // Socket [3] is last and has a sandbox perk, so ONLY the display-name check keeps it from
    // winning. This is the Ophidian Aspect shape: empty-named plug in the final perk socket.
    const exotic = exoticFrom("Grants restoration.");
    expect(exotic.exoticPerkHash).toBe(H.traitSandboxPerk);
    expect(exotic.tags.produces).not.toContain("volatile");
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
    expect(exoticFrom("Grants restoration.").modSocketHashes).toEqual([H.modSocketType]);
  });
});
