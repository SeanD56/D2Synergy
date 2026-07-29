import { describe, expect, it } from "vitest";

import {
  ARMOR_ENERGY_CAPACITY,
  buildModCapacityModel,
  canAddMod,
  evaluateModCapacity,
  type ModSocket,
} from "@/lib/validation/mod-capacity";

/**
 * Mod capacity oracle (SP3b slice 2c) — can a set of mods be legally worn on one armour piece?
 *
 * TWO independent constraints, and keeping them separate is the whole design:
 *  1. SOCKET MATCHING — each mod occupies a distinct socket whose accepted plug categories
 *     include the mod's category. Categories are per-socket sets (measured: armour mod sockets
 *     are single-category except the GENERAL socket, which accepts `enhancements.v2_general`
 *     and `enhancements.rivens_curse`).
 *  2. ENERGY BUDGET — the per-piece sum of `energyCost` must not exceed
 *     `ARMOR_ENERGY_CAPACITY` (11). Capacity is player-progression state, absent from the
 *     manifest, and we assume every piece is upgraded to the 11 maximum (user, 2026-07-29).
 *
 * The budget does NOT depend on which socket a mod lands in, so it is a plain sum check and
 * NOT part of the matching. That independence is what keeps this exact and cheap; do not fold
 * energy into the assignment search.
 *
 * ⚠️ This is NOT SP2's artifact oracle in disguise. That structure was NESTED (a tier-T socket
 * accepts every tier ≤ T), which made an upward-closed Hall's-condition walk exact. Mod sockets
 * are CATEGORICAL — no ordering between categories — so the shortcut does not transfer and a
 * real bipartite matching is required.
 */

const CAT_HEAD = "enhancements.v2_head";
const CAT_GENERAL = "enhancements.v2_general";
const CAT_RIVENS = "enhancements.rivens_curse";
const CAT_ARMS = "enhancements.v2_arms";

/** A socket accepting the given categories. */
const socket = (...categories: string[]): ModSocket => ({ categories });

const mod = (category: string, energyCost = 0) => ({ category, energyCost });

describe("ARMOR_ENERGY_CAPACITY", () => {
  it("is the upgraded maximum of 11", () => {
    // Not ingested: capacity depends on in-game upgrades, so it never appears in the manifest
    // (measured: 0 of 6029 armour items carry an `energy` block). We assume it is maxed.
    expect(ARMOR_ENERGY_CAPACITY).toBe(11);
  });
});

describe("evaluateModCapacity — socket matching", () => {
  it("accepts an empty selection", () => {
    const model = buildModCapacityModel([socket(CAT_HEAD)]);
    expect(evaluateModCapacity(model, []).feasible).toBe(true);
  });

  it("places a mod in the one socket that accepts its category", () => {
    const model = buildModCapacityModel([socket(CAT_HEAD), socket(CAT_GENERAL)]);
    expect(evaluateModCapacity(model, [mod(CAT_HEAD)]).feasible).toBe(true);
  });

  it("rejects a mod no socket accepts", () => {
    const model = buildModCapacityModel([socket(CAT_HEAD)]);
    expect(evaluateModCapacity(model, [mod(CAT_ARMS)]).feasible).toBe(false);
  });

  it("rejects more mods of one category than there are sockets for it", () => {
    const model = buildModCapacityModel([socket(CAT_HEAD), socket(CAT_GENERAL)]);
    expect(evaluateModCapacity(model, [mod(CAT_HEAD), mod(CAT_HEAD)]).feasible).toBe(false);
  });

  it("fills several distinct sockets at once", () => {
    const model = buildModCapacityModel([
      socket(CAT_HEAD), socket(CAT_HEAD), socket(CAT_HEAD), socket(CAT_GENERAL, CAT_RIVENS),
    ]);
    const mods = [mod(CAT_HEAD), mod(CAT_HEAD), mod(CAT_HEAD), mod(CAT_GENERAL)];
    expect(evaluateModCapacity(model, mods).feasible).toBe(true);
  });

  it("uses a multi-category socket for either category it accepts", () => {
    // The measured general socket: accepts v2_general AND rivens_curse.
    const model = buildModCapacityModel([socket(CAT_GENERAL, CAT_RIVENS)]);
    expect(evaluateModCapacity(model, [mod(CAT_GENERAL)]).feasible).toBe(true);
    expect(evaluateModCapacity(model, [mod(CAT_RIVENS)]).feasible).toBe(true);
    // ...but it is still ONE socket, so it cannot take both.
    expect(evaluateModCapacity(model, [mod(CAT_GENERAL), mod(CAT_RIVENS)]).feasible).toBe(false);
  });

  /**
   * THE case a greedy assignment gets wrong, and the reason this needs real matching.
   * Mod order matters to a greedy pass: the flexible mod is offered first and can consume the
   * only socket the restricted mod could have used.
   */
  it("solves an assignment a greedy first-fit would fail", () => {
    const model = buildModCapacityModel([
      socket(CAT_GENERAL, CAT_RIVENS), // flexible socket
      socket(CAT_RIVENS), //              only rivens fits here
    ]);
    // Feed the general mod FIRST. Greedy puts it in socket 0 — fine — then rivens takes
    // socket 1. Now reverse: rivens first could take socket 0, stranding general.
    expect(evaluateModCapacity(model, [mod(CAT_GENERAL), mod(CAT_RIVENS)]).feasible).toBe(true);
    expect(evaluateModCapacity(model, [mod(CAT_RIVENS), mod(CAT_GENERAL)]).feasible).toBe(true);
  });

  it("is order-independent for any solvable selection", () => {
    const model = buildModCapacityModel([
      socket(CAT_GENERAL, CAT_RIVENS), socket(CAT_RIVENS), socket(CAT_HEAD),
    ]);
    const mods = [mod(CAT_RIVENS), mod(CAT_GENERAL), mod(CAT_HEAD)];
    for (const permuted of permutations(mods)) {
      expect(evaluateModCapacity(model, permuted).feasible).toBe(true);
    }
  });
});

describe("evaluateModCapacity — energy budget", () => {
  const roomy = () => buildModCapacityModel([
    socket(CAT_HEAD), socket(CAT_HEAD), socket(CAT_HEAD), socket(CAT_HEAD), socket(CAT_HEAD),
  ]);

  it("accepts a selection exactly at capacity", () => {
    const result = evaluateModCapacity(roomy(), [mod(CAT_HEAD, 6), mod(CAT_HEAD, 5)]);
    expect(result.energyUsed).toBe(11);
    expect(result.feasible).toBe(true);
  });

  it("rejects a selection one point over capacity", () => {
    const result = evaluateModCapacity(roomy(), [mod(CAT_HEAD, 6), mod(CAT_HEAD, 6)]);
    expect(result.energyUsed).toBe(12);
    expect(result.feasible).toBe(false);
  });

  it("reports the budget so a caller can explain the failure", () => {
    const result = evaluateModCapacity(roomy(), [mod(CAT_HEAD, 3)]);
    expect(result.energyUsed).toBe(3);
    expect(result.energyCapacity).toBe(ARMOR_ENERGY_CAPACITY);
  });

  it("fails on energy even when the sockets would all match", () => {
    // Proves the two constraints are checked independently: matching is fine, budget is not.
    const result = evaluateModCapacity(roomy(), [
      mod(CAT_HEAD, 6), mod(CAT_HEAD, 6), mod(CAT_HEAD, 1),
    ]);
    expect(result.feasible).toBe(false);
  });

  it("fails on sockets even when energy is free", () => {
    const model = buildModCapacityModel([socket(CAT_HEAD)]);
    expect(evaluateModCapacity(model, [mod(CAT_ARMS, 0)]).feasible).toBe(false);
  });
});

describe("canAddMod — incremental prune", () => {
  it("permits an addition that stays feasible", () => {
    const model = buildModCapacityModel([socket(CAT_HEAD), socket(CAT_GENERAL)]);
    expect(canAddMod(model, [mod(CAT_HEAD, 3)], mod(CAT_GENERAL, 3))).toBe(true);
  });

  it("refuses an addition that would exceed the energy budget", () => {
    const model = buildModCapacityModel([socket(CAT_HEAD), socket(CAT_GENERAL)]);
    expect(canAddMod(model, [mod(CAT_HEAD, 6)], mod(CAT_GENERAL, 6))).toBe(false);
  });

  it("refuses an addition with no socket left to take it", () => {
    const model = buildModCapacityModel([socket(CAT_HEAD)]);
    expect(canAddMod(model, [mod(CAT_HEAD)], mod(CAT_HEAD))).toBe(false);
  });

  it("agrees with a full evaluate of the combined selection", () => {
    const model = buildModCapacityModel([
      socket(CAT_GENERAL, CAT_RIVENS), socket(CAT_RIVENS), socket(CAT_HEAD),
    ]);
    const current = [mod(CAT_RIVENS, 2)];
    for (const next of [mod(CAT_GENERAL, 2), mod(CAT_RIVENS, 2), mod(CAT_HEAD, 9), mod(CAT_ARMS, 1)]) {
      expect(canAddMod(model, current, next))
        .toBe(evaluateModCapacity(model, [...current, next]).feasible);
    }
  });
});

/**
 * Independent completeness check, mirroring what SP2 did for the artifact oracle (verified
 * against a bipartite-matching reference over all 2⁹ subsets) and what DIM does with its
 * `process-baseline.ts` + parity test.
 *
 * The reference here is exhaustive permutation assignment — obviously correct, far too slow to
 * ship, and therefore exactly what an exact-but-fast oracle should be checked against.
 */
describe("evaluateModCapacity — parity with an exhaustive reference", () => {
  const CATS = [CAT_HEAD, CAT_GENERAL, CAT_RIVENS];

  /** Brute force: is there ANY injective mod→socket assignment respecting categories? */
  function referenceMatches(sockets: ModSocket[], mods: { category: string }[]): boolean {
    if (mods.length > sockets.length) return false;
    const used = new Array(sockets.length).fill(false);
    const place = (i: number): boolean => {
      if (i === mods.length) return true;
      for (let s = 0; s < sockets.length; s++) {
        if (used[s] || !sockets[s].categories.includes(mods[i].category)) continue;
        used[s] = true;
        if (place(i + 1)) return true;
        used[s] = false;
      }
      return false;
    };
    return place(0);
  }

  it("matches the reference across every small socket/mod configuration", () => {
    const socketLayouts: ModSocket[][] = [
      [socket(CAT_HEAD)],
      [socket(CAT_GENERAL, CAT_RIVENS)],
      [socket(CAT_HEAD), socket(CAT_GENERAL, CAT_RIVENS)],
      [socket(CAT_RIVENS), socket(CAT_GENERAL, CAT_RIVENS)],
      [socket(CAT_HEAD), socket(CAT_HEAD), socket(CAT_GENERAL, CAT_RIVENS)],
      [socket(CAT_GENERAL, CAT_RIVENS), socket(CAT_GENERAL, CAT_RIVENS), socket(CAT_RIVENS)],
    ];

    let checked = 0;
    const sawBoth = { feasible: 0, infeasible: 0 };
    for (const sockets of socketLayouts) {
      const model = buildModCapacityModel(sockets);
      // Every mod multiset of size 0..3 over the category alphabet.
      for (let size = 0; size <= 3; size++) {
        for (const combo of tuples(CATS, size)) {
          const mods = combo.map((c) => mod(c, 0)); // energy free — isolate matching
          const actual = evaluateModCapacity(model, mods).feasible;
          const expected = referenceMatches(sockets, mods);
          expect(actual, `sockets=${JSON.stringify(sockets)} mods=${JSON.stringify(combo)}`)
            .toBe(expected);
          checked++;
          if (expected) sawBoth.feasible++; else sawBoth.infeasible++;
        }
      }
    }
    // Anti-vacuity: the sweep must actually cover both outcomes, or agreement proves nothing.
    expect(checked).toBeGreaterThan(200);
    expect(sawBoth.feasible).toBeGreaterThan(0);
    expect(sawBoth.infeasible).toBeGreaterThan(0);
  });
});

/** All ordered tuples of `size` drawn from `xs` (with repetition). */
function tuples<T>(xs: T[], size: number): T[][] {
  if (size === 0) return [[]];
  return tuples(xs, size - 1).flatMap((rest) => xs.map((x) => [...rest, x]));
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
}
