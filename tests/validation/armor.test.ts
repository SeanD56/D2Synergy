import { expect, it } from "vitest";

import type { ArmorSlot, Build } from "@/lib/types";
import type { Lookup } from "@/lib/validation/types";
import { armorRules } from "@/lib/validation/armor";

function run(build: Build, lookup: Partial<Lookup>): string[] {
  return armorRules.flatMap((r) => r(build, lookup as Lookup)).map((v) => v.code);
}

const base: Build = {
  subclass: { aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
};

// helper armor entities
const A = (hash: number, slot: string, tier: string, classType: string, setHash?: number) =>
  ({ hash, name: `A${hash}`, slot, tier, classType, setHash }) as never;

const lookup: Partial<Lookup> = {
  armor: (h) =>
    (({
      1: A(1, "helmet", "exotic", "titan"),
      2: A(2, "arms", "exotic", "titan"),
      3: A(3, "chest", "legendary", "hunter"),
      4: A(4, "helmet", "legendary", "titan", 900),
      5: A(5, "arms", "legendary", "titan", 900),
    }) as never)[h],
};

it("flags more than one exotic", () => {
  const b: Build = { ...base, armor: { ...base.armor, pieces: [
    { slot: "helmet", itemHash: 1 }, { slot: "arms", itemHash: 2 },
  ] } };
  expect(run(b, lookup)).toContain("MULTIPLE_EXOTIC_ARMOR");
});

it("flags mixed classes", () => {
  const b: Build = { ...base, armor: { ...base.armor, pieces: [
    { slot: "helmet", itemHash: 1 }, { slot: "chest", itemHash: 3 },
  ] } };
  expect(run(b, lookup)).toContain("ARMOR_CLASS_MISMATCH");
});

it("flags two pieces in the same slot", () => {
  const b: Build = { ...base, armor: { ...base.armor, pieces: [
    { slot: "helmet", itemHash: 1 }, { slot: "helmet", itemHash: 4 },
  ] } };
  expect(run(b, lookup)).toContain("DUPLICATE_ARMOR_SLOT");
});

it("flags a set bonus without enough pieces", () => {
  const b: Build = { ...base, armor: { ...base.armor,
    pieces: [{ slot: "helmet", itemHash: 4 }],
    setBonuses: [{ setHash: 900, requiredCount: 2 }],
  } };
  expect(run(b, lookup)).toContain("SET_COUNT_INVALID");
});

it("flags a complete 5-piece set with no exotic", () => {
  const legendary = (h: number, slot: ArmorSlot) => ({ slot, itemHash: h });
  const lk: Partial<Lookup> = { armor: (h) => A(h, "x", "legendary", "titan") };
  const b: Build = { ...base, armor: { ...base.armor, pieces: [
    legendary(10, "helmet"), legendary(11, "arms"), legendary(12, "chest"),
    legendary(13, "legs"), legendary(14, "class"),
  ] } };
  expect(run(b, lk)).toContain("MISSING_EXOTIC_ARMOR");
});
