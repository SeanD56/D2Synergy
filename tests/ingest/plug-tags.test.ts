import { describe, expect, it } from "vitest";

import { createClassifier } from "../../scripts/ingest/classify";
import { createKeywordTagger } from "../../scripts/ingest/keywords";
import { transformAll } from "../../scripts/ingest/transform";

import { H, makeSlice } from "./fixtures";

const WEAPON_CATEGORY = 1;
const KINETIC_BUCKET = 1498876634;
const PERK_CATEGORY = 6001;
const PLUG_SET = 7001;
const WEAPON_A = 2001;
const WEAPON_B = 2002;
const TAGGED_PLUG = 3001;
const PLAIN_PLUG = 3002;

/** A slice with two weapons sharing one plug set: one tagged plug, one not. */
function weaponSlice() {
  const slice = makeSlice() as unknown as Record<string, Record<number, unknown>>;
  slice.DestinyItemCategoryDefinition[WEAPON_CATEGORY] = {
    hash: WEAPON_CATEGORY,
    displayProperties: { name: "Weapon" },
  };
  slice.DestinyInventoryBucketDefinition[KINETIC_BUCKET] = {
    hash: KINETIC_BUCKET,
    displayProperties: { name: "Kinetic Weapons" },
  };
  slice.DestinySocketCategoryDefinition[PERK_CATEGORY] = {
    hash: PERK_CATEGORY,
    displayProperties: { name: "Weapon Perks" },
  };
  slice.DestinyPlugSetDefinition[PLUG_SET] = {
    hash: PLUG_SET,
    reusablePlugItems: [
      { plugItemHash: TAGGED_PLUG, currentlyCanRoll: true },
      { plugItemHash: PLAIN_PLUG, currentlyCanRoll: true },
    ],
  };
  slice.DestinyInventoryItemDefinition[TAGGED_PLUG] = {
    hash: TAGGED_PLUG,
    displayProperties: { name: "Voltshot", description: "Reloading jolts targets." },
  };
  slice.DestinyInventoryItemDefinition[PLAIN_PLUG] = {
    hash: PLAIN_PLUG,
    displayProperties: { name: "Smallbore", description: "Increases range." },
  };
  for (const hash of [WEAPON_A, WEAPON_B]) {
    slice.DestinyInventoryItemDefinition[hash] = {
      hash,
      itemType: 3,
      itemCategoryHashes: [WEAPON_CATEGORY],
      displayProperties: { name: `Weapon ${hash}`, description: "" },
      inventory: { bucketTypeHash: KINETIC_BUCKET, tierTypeName: "Legendary" },
      equippingBlock: { ammoType: 1 },
      sockets: {
        socketCategories: [{ socketCategoryHash: PERK_CATEGORY, socketIndexes: [0] }],
        socketEntries: [{ randomizedPlugSetHash: PLUG_SET }],
      },
    };
  }
  return slice as unknown as Parameters<typeof createClassifier>[0];
}

describe("plug-tags side table", () => {
  const run = () => {
    const slice = weaponSlice();
    return transformAll(slice, createClassifier(slice), createKeywordTagger());
  };

  it("tags each distinct plug hash once, keyed by plug hash", () => {
    const { plugTags } = run();
    expect(plugTags[TAGGED_PLUG]?.produces).toContain("jolt");
  });

  it("omits plugs whose text yields no tags", () => {
    expect(run().plugTags[PLAIN_PLUG]).toBeUndefined();
  });

  it("does not inline tags onto WeaponPerk entries", () => {
    const weapon = run().weapons.find((w) => w.hash === WEAPON_A)!;
    const plug = weapon.perkColumns[0].plugs.find((p) => p.hash === TAGGED_PLUG)!;
    expect(Object.keys(plug).sort()).toEqual(["hash", "name"]);
  });

  it("dedupes across weapons sharing a plug", () => {
    const { plugTags, weapons } = run();
    expect(weapons).toHaveLength(2);
    expect(Object.keys(plugTags)).toEqual([String(TAGGED_PLUG)]);
  });

  it("keeps the armor fixture path working (transformAll still returns armor)", () => {
    expect(run().armor).toEqual([]);
    expect(H.armorCategory).toBe(20); // fixture sanity
  });
});
