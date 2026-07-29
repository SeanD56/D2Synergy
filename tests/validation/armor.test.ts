import { describe, expect, it } from "vitest";

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

// Until the solver gained the exotic dimension nothing populated `armor.exoticHash` and
// `armor.pieces` together, so these three paths were unreachable. They become real the
// moment SP4 populates `pieces` alongside a solver-chosen exotic.
describe("exoticCount — pieces/exoticHash union (slice 2b)", () => {
  // 1 and 2 are exotic titan (from the shared fixture above); 20+ are legendary titan.
  const lk: Partial<Lookup> = {
    armor: (h) =>
      (h === 1 ? A(1, "helmet", "exotic", "titan")
        : h === 2 ? A(2, "arms", "exotic", "titan")
          : A(h, "x", "legendary", "titan")),
  };
  const slots: ArmorSlot[] = ["helmet", "arms", "chest", "legs", "class"];
  const fiveLegendary = slots.map((slot, i) => ({ slot, itemHash: 20 + i }));

  it("does not flag MISSING_EXOTIC_ARMOR for five legendary pieces plus a solver-chosen exotic", () => {
    // Anti-vacuity: the same five pieces WITHOUT the exotic are the classic missing-exotic case.
    const without: Build = { ...base, armor: { ...base.armor, pieces: fiveLegendary } };
    expect(run(without, lk)).toContain("MISSING_EXOTIC_ARMOR");

    const b: Build = { ...base, armor: { ...base.armor, pieces: fiveLegendary, exoticHash: 1 } };
    expect(run(b, lk)).toEqual([]);
  });

  it("flags an exotic piece plus a DIFFERENT exoticHash as a two-exotic build", () => {
    const b: Build = { ...base, armor: { ...base.armor,
      pieces: [{ slot: "helmet", itemHash: 1 }], exoticHash: 2 } };
    expect(run(b, lk)).toEqual(["MULTIPLE_EXOTIC_ARMOR"]);
  });

  it("counts the SAME exotic named in both fields as exactly one", () => {
    const b: Build = { ...base, armor: { ...base.armor,
      pieces: [{ slot: "helmet", itemHash: 1 }], exoticHash: 1 } };
    expect(run(b, lk)).toEqual([]);
  });

  it("applies the <=4-per-set rule when the exotic lives only in exoticHash", () => {
    const set: Partial<Lookup> = { armor: (h) =>
      (h === 1 ? A(1, "helmet", "exotic", "titan") : A(h, "x", "legendary", "titan", 900)) };
    const b: Build = { ...base, armor: { ...base.armor,
      pieces: fiveLegendary, exoticHash: 1 } };
    expect(run(b, set)).toContain("SET_COUNT_INVALID");
  });
});

describe("classConsistency — build class match (slice 2b)", () => {
  // A(hash, slot, tier, classType) is the existing helper defined above in this file.
  // NOTE (deviation from brief): hash 901 is "legendary" here, not "exotic" as the brief's
  // verbatim text specifies. With both 900 and 901 tier "exotic", the "still catches pieces
  // spanning multiple classes" case below feeds both hashes into armor.pieces, and the
  // pre-existing exoticCount rule (tier === "exotic") then also fires MULTIPLE_EXOTIC_ARMOR,
  // breaking that test's exact-match assertion — contradicting the brief's own claim that
  // "the other three armor rules stay silent" for these fixtures. tier plays no role in
  // classConsistency (only classType does), so this one-word change preserves every
  // behavior the brief's tests actually exercise while removing the incidental collision.
  const lookup = {
    armor: (h: number) =>
      h === 900 ? A(900, "helmet", "exotic", "warlock")
        : h === 901 ? A(901, "arms", "legendary", "titan")
          : undefined,
    armorSet: () => undefined,
  } as Partial<Lookup>;

  const withClass = (classType: string | undefined, armor: Record<string, unknown>): Build => ({
    ...base,
    subclass: { ...base.subclass, classType },
    armor: { ...base.armor, ...armor },
  }) as unknown as Build;

  it("flags an exoticHash whose class contradicts the pinned build class", () => {
    expect(run(withClass("warlock", { exoticHash: 901 }), lookup))
      .toContain("ARMOR_CLASS_MISMATCH");
  });

  it("accepts an exoticHash matching the pinned build class", () => {
    expect(run(withClass("warlock", { exoticHash: 900 }), lookup)).toEqual([]);
  });

  it("does NOT fire when classType is absent (every pre-slice-2b build stays valid)", () => {
    expect(run(withClass(undefined, { exoticHash: 901 }), lookup)).toEqual([]);
  });

  // The first clause considers `exoticHash` UNCONDITIONALLY — it does not need a pinned
  // classType, and it is deliberately tier-agnostic (901 is legendary here). Isolating this
  // matters because a build carrying both an `exoticHash` and `pieces` only became a real
  // shape once the solver started writing `exoticHash`.
  it("flags an exoticHash and pieces of different classes with NO class pinned", () => {
    expect(run(
      withClass(undefined, { pieces: [{ slot: "arms", itemHash: 901 }], exoticHash: 900 }),
      lookup,
    )).toEqual(["ARMOR_CLASS_MISMATCH"]);
  });

  it("still catches pieces spanning multiple classes with no class pinned", () => {
    expect(run(
      withClass(undefined, {
        pieces: [{ slot: "helmet", itemHash: 900 }, { slot: "arms", itemHash: 901 }],
      }),
      lookup,
    )).toEqual(["ARMOR_CLASS_MISMATCH"]);
  });
});
