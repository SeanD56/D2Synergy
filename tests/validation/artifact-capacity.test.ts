import { describe, expect, it } from "vitest";

import type { Artifact, Hash } from "@/lib/types";
import {
  buildCapacityModel,
  canAdd,
  evaluate,
  type CapacityModel,
} from "@/lib/validation/artifact-capacity";

// Cumulative-pool artifact: sockets 2/3/2. Native tiers: 1,2 -> t0; 3,4,5 -> t1;
// 6,7,8 -> t2. Each perk also recurs in every higher tier's pool.
const artifact = {
  hash: 500,
  name: "Test",
  kind: "artifact",
  tags: undefined,
  tiers: [
    { tierIndex: 0, slots: 2, perks: [{ hash: 1 }, { hash: 2 }] },
    { tierIndex: 1, slots: 3, perks: [{ hash: 1 }, { hash: 2 }, { hash: 3 }, { hash: 4 }, { hash: 5 }] },
    { tierIndex: 2, slots: 2, perks: [{ hash: 1 }, { hash: 2 }, { hash: 3 }, { hash: 4 }, { hash: 5 }, { hash: 6 }, { hash: 7 }, { hash: 8 }] },
  ],
} as unknown as Artifact;

describe("buildCapacityModel", () => {
  it("resolves native tier to the lowest (first) tier a perk appears in", () => {
    const m = buildCapacityModel(artifact);
    expect(m.nativeTier.get(1)).toBe(0);
    expect(m.nativeTier.get(3)).toBe(1);
    expect(m.nativeTier.get(6)).toBe(2);
    expect(m.socketsByTier).toEqual([2, 3, 2]);
    expect(m.capacity).toBe(7);
  });

  it("is order-independent (tiers given high->low resolve the same native tiers)", () => {
    const reversed = { ...artifact, tiers: [...artifact.tiers].reverse() } as Artifact;
    const m = buildCapacityModel(reversed);
    expect(m.nativeTier.get(1)).toBe(0);
    expect(m.nativeTier.get(6)).toBe(2);
    expect(m.socketsByTier).toEqual([2, 3, 2]);
  });
});

describe("evaluate", () => {
  const m = buildCapacityModel(artifact);

  it("accepts a legal 2/3/2 fill (7 distinct perks) as feasible and exactly full", () => {
    const cap = evaluate(m, [1, 2, 3, 4, 5, 6, 7]);
    expect(cap.feasible).toBe(true);
    expect(cap.selected).toBe(7);
    expect(cap.capacity).toBe(7);
    expect(cap.headroomByTier).toEqual([0, 0, 0]);
  });

  it("treats a partial selection as feasible (never rejects legal-so-far)", () => {
    const cap = evaluate(m, [1]);
    expect(cap.feasible).toBe(true);
    expect(cap.selected).toBe(1);
    // headroom[0] = 7-1, headroom[1] = 5-0, headroom[2] = 2-0
    expect(cap.headroomByTier).toEqual([6, 5, 2]);
  });

  it("is infeasible when a tier threshold is over-subscribed (3 perks needing tier>=2 into 2 sockets)", () => {
    const cap = evaluate(m, [6, 7, 8]); // all native t2; tier>=2 needs 3 > 2 sockets
    expect(cap.feasible).toBe(false);
    expect(cap.headroomByTier[2]).toBeLessThan(0);
  });

  it("dedups and ignores unknown (non-placeable) hashes", () => {
    const cap = evaluate(m, [1, 1, 2, 999]); // 999 unknown, 1 duplicated
    expect(cap.selected).toBe(2);
    expect(cap.feasible).toBe(true);
  });
});

describe("canAdd", () => {
  const m = buildCapacityModel(artifact);

  it("permits adding a perk when its tier threshold has headroom", () => {
    const cap = evaluate(m, [1]); // headroom [6,5,2]
    expect(canAdd(m, cap, 0)).toBe(true);
    expect(canAdd(m, cap, 2)).toBe(true);
  });

  it("refuses adding a perk when a threshold at or below its native tier is exhausted", () => {
    const cap = evaluate(m, [6, 7]); // both native t2; headroom[2] = 2-2 = 0
    expect(cap.headroomByTier[2]).toBe(0);
    expect(canAdd(m, cap, 2)).toBe(false); // no tier>=2 socket left
    expect(canAdd(m, cap, 0)).toBe(true); // a tier-0 perk can still take a low socket
  });
});

// Independent completeness check: evaluate().feasible must equal actual
// bipartite matchability of perks->sockets (socket accepts perk iff its tier >=
// the perk's native tier), for EVERY subset of a synthetic pool. Proves the
// Hall math is exact, not a conservative approximation.
describe("evaluate completeness vs. bipartite matching", () => {
  const socketsByTier = [2, 3, 2];
  // Synthetic pool: 3 perks native to each tier (hashes encode native tier).
  const pool: { hash: Hash; tier: number }[] = [
    { hash: 100, tier: 0 }, { hash: 101, tier: 0 }, { hash: 102, tier: 0 },
    { hash: 110, tier: 1 }, { hash: 111, tier: 1 }, { hash: 112, tier: 1 },
    { hash: 120, tier: 2 }, { hash: 121, tier: 2 }, { hash: 122, tier: 2 },
  ];
  const model: CapacityModel = {
    nativeTier: new Map(pool.map((p) => [p.hash, p.tier])),
    socketsByTier,
    capacity: socketsByTier.reduce((s, n) => s + n, 0),
  };

  function feasibleByMatching(perkTiers: number[]): boolean {
    const sockets: number[] = [];
    socketsByTier.forEach((n, t) => {
      for (let i = 0; i < n; i++) sockets.push(t);
    });
    const socketToPerk = new Array<number>(sockets.length).fill(-1);
    const assign = (perk: number, seen: boolean[]): boolean => {
      for (let s = 0; s < sockets.length; s++) {
        if (sockets[s] >= perkTiers[perk] && !seen[s]) {
          seen[s] = true;
          if (socketToPerk[s] === -1 || assign(socketToPerk[s], seen)) {
            socketToPerk[s] = perk;
            return true;
          }
        }
      }
      return false;
    };
    let matched = 0;
    for (let p = 0; p < perkTiers.length; p++) {
      if (assign(p, new Array(sockets.length).fill(false))) matched += 1;
    }
    return matched === perkTiers.length;
  }

  it("matches the matching-reference on all 2^9 subsets", () => {
    for (let mask = 0; mask < 1 << pool.length; mask++) {
      const subset = pool.filter((_, i) => (mask >> i) & 1);
      const hashes = subset.map((p) => p.hash);
      const tiers = subset.map((p) => p.tier);
      expect(evaluate(model, hashes).feasible).toBe(feasibleByMatching(tiers));
    }
  });
});
