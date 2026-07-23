import { describe, expect, it } from "vitest";

import type { Build } from "@/lib/types";
import type { Lookup } from "@/lib/validation/types";
import { weaponRules } from "@/lib/validation/weapons";

function run(build: Build, lookup: Partial<Lookup>): string[] {
  return weaponRules.flatMap((r) => r(build, lookup as Lookup)).map((v) => v.code);
}

const base: Build = {
  subclass: { aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
};

// hash 100: energy weapon, special ammo, columns [ {idx0: A,B}, {idx1: C} ]
// hash 200: kinetic weapon, primary ammo
const lookup: Partial<Lookup> = {
  weapon: (h) =>
    (({
      100: {
        hash: 100, name: "Gun", slot: "energy", ammoType: "special",
        perkColumns: [
          { socketIndex: 0, plugs: [{ hash: 1, name: "Rampage" }, { hash: 2, name: "Kill Clip" }] },
          { socketIndex: 1, plugs: [{ hash: 3, name: "Outlaw" }] },
        ],
      },
      200: { hash: 200, name: "Hand Cannon", slot: "kinetic", ammoType: "primary", perkColumns: [] },
    }) as never)[h],
};

it("flags a perk not in the weapon's pool", () => {
  const b: Build = { ...base, weapons: [{ slot: "energy", itemHash: 100, perkConstraints: [{ perkName: "Frenzy" }] }] };
  expect(run(b, lookup)).toContain("PERK_NOT_IN_POOL");
});

it("flags two requested perks that share one column", () => {
  const b: Build = { ...base, weapons: [{ slot: "energy", itemHash: 100, perkConstraints: [{ perkName: "Rampage" }, { perkName: "Kill Clip" }] }] };
  expect(run(b, lookup)).toContain("PERK_COLUMN_CONFLICT");
});

it("allows perks in different columns", () => {
  const b: Build = { ...base, weapons: [{ slot: "energy", itemHash: 100, perkConstraints: [{ perkName: "Rampage" }, { perkName: "Outlaw" }] }] };
  expect(run(b, lookup)).not.toContain("PERK_COLUMN_CONFLICT");
});

it("flags a weapon placed in the wrong slot", () => {
  const b: Build = { ...base, weapons: [{ slot: "power", itemHash: 100, perkConstraints: [] }] };
  expect(run(b, lookup)).toContain("WEAPON_SLOT_MISMATCH");
});

it("flags two weapons in the same slot", () => {
  const b: Build = { ...base, weapons: [
    { slot: "kinetic", itemHash: 200, perkConstraints: [] },
    { slot: "kinetic", itemHash: 200, perkConstraints: [] },
  ] };
  expect(run(b, lookup)).toContain("DUPLICATE_WEAPON_SLOT");
});

it("flags double-primary but allows a special in the mix", () => {
  const doublePrimary: Build = { ...base, weapons: [
    { slot: "kinetic", itemHash: 200, perkConstraints: [] },
    { slot: "energy", itemHash: 200, perkConstraints: [] },
  ] };
  expect(run(doublePrimary, lookup)).toContain("DOUBLE_PRIMARY_AMMO");

  const withSpecial: Build = { ...base, weapons: [
    { slot: "kinetic", itemHash: 200, perkConstraints: [] },
    { slot: "energy", itemHash: 100, perkConstraints: [] },
  ] };
  expect(run(withSpecial, lookup)).not.toContain("DOUBLE_PRIMARY_AMMO");
});
