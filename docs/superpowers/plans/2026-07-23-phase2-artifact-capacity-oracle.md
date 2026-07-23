# Phase 2 · SP2 — Artifact Capacity Oracle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract artifact perk-capacity legality into a pure, precompute-backed feasibility oracle shared by the Phase-1 validator and the (future) SP3 beam-search solver — without changing the `Build.artifact` data model.

**Architecture:** A new pure module `src/lib/validation/artifact-capacity.ts` exposes `buildCapacityModel(artifact)` (per-artifact precompute, hoisted out of the solver's hot loop), `evaluate(model, selectedHashes)` (per-selection feasibility + tier headroom), and `canAdd(model, cap, nativeTier)` (O(tier) incremental prune). Artifact tiers are a cumulative *ceiling* (a tier-T socket accepts tier ≤ T perks), so feasibility is the exact Hall's-condition test over nested/upward-closed socket neighborhoods. The existing `tierCapacity` rule is refactored into a thin adapter over the oracle; `Build.artifact` and all synergy code are untouched.

**Tech Stack:** TypeScript (strict), Vitest, `pnpm`. `@/*` → `src/*`. No new dependencies.

## Global Constraints

- **Model unchanged:** `Build.artifact` stays flat (`selectedPerkHashes: Hash[]`). No per-tier/socket restructure. Synergy code (`collectBuildElements`) is not touched.
- **Oracle is pure:** `artifact-capacity.ts` imports only from `@/lib/types`. No `Lookup`, no filesystem, no I/O. Deterministic — no dependence on input order.
- **Native tier = lowest tier a perk appears in.** Pools are cumulative (7/14/21); a perk hash recurs in every tier at/above where it unlocks. First-tier attribution is authoritative (locked by existing test on artifact hash `501`).
- **`feasible` = "not over capacity."** A partial/underfilled selection IS feasible. `UNDERFILLED` is a validator-only advisory, never an oracle concern.
- **Only placeable (known) perks count** in the oracle. Unknown / name-only hashes are ignored here and remain `perkMembership`'s job (unchanged).
- **Layering:** `@/lib/validation` must not import from `@/lib/synergy`. The oracle lives under `validation/`.
- **Regression floor:** baseline is **63 tests pass**, `tsc --noEmit` clean, `eslint scripts src tests` clean. Existing `tests/validation/artifact.test.ts` cases must stay green (they assert `.code` only; messages may change).

---

### Task 1: Pure capacity oracle (`buildCapacityModel` / `evaluate` / `canAdd`)

**Files:**
- Create: `src/lib/validation/artifact-capacity.ts`
- Test: `tests/validation/artifact-capacity.test.ts`

**Interfaces:**
- Consumes: `Artifact`, `Hash` from `@/lib/types`.
- Produces:
  - `interface CapacityModel { nativeTier: Map<Hash, number>; socketsByTier: number[]; capacity: number }`
  - `interface Capacity { feasible: boolean; selected: number; capacity: number; headroomByTier: number[] }`
  - `buildCapacityModel(artifact: Artifact): CapacityModel`
  - `evaluate(model: CapacityModel, selectedHashes: Hash[]): Capacity`
  - `canAdd(model: CapacityModel, cap: Capacity, nativeTier: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/validation/artifact-capacity.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { Artifact, Hash } from "@/lib/types";
import {
  buildCapacityModel,
  canAdd,
  evaluate,
  type CapacityModel,
} from "@/lib/validation/artifact-capacity";

// Cumulative-pool artifact: sockets 2/3/2. Native tiers: 1,2 -> t0; 3,4,5 -> t1;
// 6,7,8 -> t2. Each perk also recurs in every higher tier's pool. Note tier 2
// has THREE native perks (6,7,8) but only 2 sockets, so an all-tier-2 selection
// is over capacity — the case the infeasibility tests below exercise.
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/validation/artifact-capacity.test.ts`
Expected: FAIL — `@/lib/validation/artifact-capacity` does not exist.

- [ ] **Step 3: Implement the oracle**

Create `src/lib/validation/artifact-capacity.ts`:

```ts
import type { Artifact, Hash } from "@/lib/types";

/**
 * Per-artifact precompute for capacity checks. Built ONCE per artifact; the SP3
 * beam search hoists this out of its inner loop and reuses it across selections.
 */
export interface CapacityModel {
  /** Perk hash -> lowest (native) tier index it appears in. */
  nativeTier: Map<Hash, number>;
  /** socketsByTier[t] = number of sockets in tier t (index === tierIndex). */
  socketsByTier: number[];
  /** Total sockets across all tiers (Σ socketsByTier). */
  capacity: number;
}

/** Per-selection capacity verdict. `feasible` means "not over capacity". */
export interface Capacity {
  /** True iff a legal socket assignment exists (partial selections are feasible). */
  feasible: boolean;
  /** Count of distinct, placeable (known) selected perks. */
  selected: number;
  /** === model.capacity, echoed for convenience. */
  capacity: number;
  /**
   * headroomByTier[k] = free sockets available to a perk whose NATIVE tier is k
   * = (sockets with tier >= k) − (selected perks with native tier >= k).
   * `feasible` iff every entry >= 0.
   */
  headroomByTier: number[];
}

/**
 * Artifact tiers are a cumulative CEILING: a tier-T socket accepts perks native
 * to tier <= T, so a perk's native tier (its lowest appearance) is the floor of
 * sockets it can occupy. Resolve native tiers + per-tier socket counts once.
 */
export function buildCapacityModel(artifact: Artifact): CapacityModel {
  const tiers = [...artifact.tiers].sort((a, b) => a.tierIndex - b.tierIndex);
  const nativeTier = new Map<Hash, number>();
  const socketsByTier: number[] = [];
  for (const tier of tiers) {
    socketsByTier[tier.tierIndex] = tier.slots;
    for (const p of tier.perks) {
      if (!nativeTier.has(p.hash)) nativeTier.set(p.hash, tier.tierIndex);
    }
  }
  const capacity = socketsByTier.reduce((sum, n) => sum + (n ?? 0), 0);
  return { nativeTier, socketsByTier, capacity };
}

/**
 * Feasibility over the nested socket structure. Because socket neighborhoods are
 * upward-closed (a perk fits any socket of tier >= its native tier), Hall's
 * condition reduces to checking, at every tier threshold k, that the perks
 * requiring tier >= k do not outnumber the sockets of tier >= k. This is exact —
 * see the completeness test against a bipartite-matching reference.
 */
export function evaluate(model: CapacityModel, selectedHashes: Hash[]): Capacity {
  const nTiers = model.socketsByTier.length;

  // Distinct, placeable (known) perks only; unknowns are perkMembership's job.
  const placeable = [...new Set(selectedHashes)].filter((h) =>
    model.nativeTier.has(h),
  );

  // needAtOrAbove[k] = count of selected perks whose native tier >= k.
  const needAtOrAbove = new Array<number>(nTiers).fill(0);
  for (const h of placeable) {
    const t = model.nativeTier.get(h)!;
    for (let k = 0; k <= t; k++) needAtOrAbove[k] += 1;
  }

  // headroomByTier[k] = (Σ_{t>=k} sockets) − needAtOrAbove[k].
  const headroomByTier = new Array<number>(nTiers).fill(0);
  let socketsAtOrAbove = 0;
  for (let k = nTiers - 1; k >= 0; k--) {
    socketsAtOrAbove += model.socketsByTier[k] ?? 0;
    headroomByTier[k] = socketsAtOrAbove - needAtOrAbove[k];
  }

  return {
    feasible: headroomByTier.every((h) => h >= 0),
    selected: placeable.length,
    capacity: model.capacity,
    headroomByTier,
  };
}

/**
 * O(tier) incremental prune for beam search: can a perk with the given native
 * tier be added to the selection `cap` describes and stay feasible? Adding a
 * native-tier-t perk consumes one socket from every threshold k <= t, so every
 * such threshold must have >= 1 headroom. Assumes the perk is placeable and not
 * already selected (caller's responsibility).
 */
export function canAdd(
  model: CapacityModel,
  cap: Capacity,
  nativeTier: number,
): boolean {
  const upper = Math.min(nativeTier, cap.headroomByTier.length - 1);
  for (let k = 0; k <= upper; k++) {
    if (cap.headroomByTier[k] < 1) return false;
  }
  return true;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm test tests/validation/artifact-capacity.test.ts && pnpm exec tsc --noEmit`
Expected: all PASS (including the 512-subset completeness check); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/artifact-capacity.ts tests/validation/artifact-capacity.test.ts
git commit -m "Add pure artifact capacity oracle (buildCapacityModel/evaluate/canAdd)"
```

---

### Task 2: Refactor `tierCapacity` onto the oracle + export the seam

**Files:**
- Modify: `src/lib/validation/artifact.ts` (replace the `tierCapacity` rule body; `perkMembership` untouched)
- Modify: `src/lib/validation/index.ts` (re-export the oracle for the SP3 solver)
- Test: `tests/validation/artifact.test.ts` (add one case; existing cases must stay green)

**Interfaces:**
- Consumes: `buildCapacityModel`, `evaluate` from `./artifact-capacity` (Task 1).
- Produces: `tierCapacity` now emits `ARTIFACT_TIER_OVER_CAP` when `!feasible`, `ARTIFACT_TIER_UNDERFILLED` when `selected < capacity` — at most one, never both. Public re-exports from `@/lib/validation`: `buildCapacityModel`, `evaluateArtifactCapacity` (alias of `evaluate`), `canAddArtifactPerk` (alias of `canAdd`), and types `CapacityModel`, `Capacity`.

- [ ] **Step 1: Write the failing test**

Add to `tests/validation/artifact.test.ts` (append at end; reuses the existing `base` and `run`). NOTE: the existing `lookup` on artifact `500` (natives 1,2→t0; 3,4,5→t1; 6,7→t2) has a "tight" pool where every subset fits — infeasibility is not constructible from it. Add a fixture whose top tier has MORE native perks than its sockets:

```ts
// Capacity stub (hash 600): slots 2/3/2, cumulative pools. tier 2 has THREE
// native perks [7,8,9] against 2 sockets, so an all-tier-2 selection is over cap.
const capacityLookup: Partial<Lookup> = {
  artifact: (h) =>
    h === 600
      ? ({
          hash: 600, name: "Capacity Artifact",
          tiers: [
            { tierIndex: 0, slots: 2, perks: [{ hash: 1 }, { hash: 2 }, { hash: 3 }, { hash: 4 }] },
            { tierIndex: 1, slots: 3, perks: [{ hash: 1 }, { hash: 2 }, { hash: 3 }, { hash: 4 }, { hash: 5 }, { hash: 6 }] },
            { tierIndex: 2, slots: 2, perks: [{ hash: 1 }, { hash: 2 }, { hash: 3 }, { hash: 4 }, { hash: 5 }, { hash: 6 }, { hash: 7 }, { hash: 8 }, { hash: 9 }] },
          ],
        } as never)
      : undefined,
};

it("does NOT flag over-cap when low-tier perks can fill higher sockets", () => {
  // 4 perks all native to tier 0 — legal across the 2 tier-0 + higher sockets.
  const b = { ...base, artifact: { artifactHash: 600, selectedPerkHashes: [1, 2, 3, 4] } };
  expect(run(b, capacityLookup)).not.toContain("ARTIFACT_TIER_OVER_CAP");
});

it("reports a single OVER_CAP (not also UNDERFILLED) when over-constrained yet under total capacity", () => {
  // 7,8,9 all native to tier 2 (2 sockets): three perks need tier>=2 sockets but
  // only 2 exist -> infeasible. Total (3) < capacity (7). The oracle emits
  // OVER_CAP only; "underfilled" would be contradictory (the old rule emitted both).
  const b = { ...base, artifact: { artifactHash: 600, selectedPerkHashes: [7, 8, 9] } };
  const codes = run(b, capacityLookup);
  expect(codes).toContain("ARTIFACT_TIER_OVER_CAP");
  expect(codes).not.toContain("ARTIFACT_TIER_UNDERFILLED");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/validation/artifact.test.ts`
Expected: FAIL — current `tierCapacity` emits BOTH `ARTIFACT_TIER_UNDERFILLED` (selected 3 < 7) and a nested `ARTIFACT_TIER_OVER_CAP`, so the `not.toContain` assertion fails.

- [ ] **Step 3: Refactor the rule onto the oracle**

In `src/lib/validation/artifact.ts`, add the import at the top (after the existing `import type { Rule, Violation } from "./types";`):

```ts
import { buildCapacityModel, evaluate } from "./artifact-capacity";
```

Replace the entire `tierCapacity` rule (the block from its doc-comment through its closing `};`, i.e. the current lines starting at `/**\n * Phase 1 (partial): ...` down to the end of `const tierCapacity: Rule = ...`) with:

```ts
/**
 * Artifact tiers are a cumulative CEILING (a tier-T socket accepts tier <= T
 * perks; pools are cumulative 7/14/21). Capacity legality is a nested bipartite
 * feasibility problem, delegated to the pure `artifact-capacity` oracle — the
 * same oracle the SP3 solver uses. This rule is a thin adapter: over capacity ->
 * ARTIFACT_TIER_OVER_CAP; feasible-but-not-full -> ARTIFACT_TIER_UNDERFILLED
 * (a build-canvas advisory). At most one fires; an over-constrained selection
 * is reported as OVER_CAP, never simultaneously "underfilled". Unknown perks
 * are handled by `perkMembership` and ignored here. See memory:
 * artifact-tier-pools-cumulative.
 */
const tierCapacity: Rule = (build, lookup) => {
  const { artifactHash, selectedPerkHashes } = build.artifact;
  if (artifactHash === undefined) return [];
  const artifact = lookup.artifact(artifactHash);
  if (!artifact) return [];

  const cap = evaluate(buildCapacityModel(artifact), selectedPerkHashes);

  if (!cap.feasible) {
    return [
      {
        code: "ARTIFACT_TIER_OVER_CAP",
        category: "game",
        message: `Too many artifact perks for the available sockets (capacity ${cap.capacity}).`,
        subject: { kind: "artifact", hash: artifact.hash },
      },
    ];
  }
  if (cap.selected < cap.capacity) {
    return [
      {
        code: "ARTIFACT_TIER_UNDERFILLED",
        category: "game",
        message: `Fill all ${cap.capacity} artifact perk slots; ${cap.selected} selected.`,
        subject: { kind: "artifact", hash: artifact.hash },
      },
    ];
  }
  return [];
};
```

Note: the `Violation` import may now be unused in this file if no other rule references it. If `pnpm exec eslint` reports `Violation` as unused, remove it from the `import type { Rule, Violation } from "./types";` line (leaving `import type { Rule } from "./types";`). `perkMembership` and the `export const artifactRules = [perkMembership, tierCapacity];` line are unchanged.

- [ ] **Step 4: Export the oracle seam**

In `src/lib/validation/index.ts`, add after the existing `export { createLookup } from "./lookup";` line:

```ts
export {
  buildCapacityModel,
  evaluate as evaluateArtifactCapacity,
  canAdd as canAddArtifactPerk,
} from "./artifact-capacity";
export type { CapacityModel, Capacity } from "./artifact-capacity";
```

- [ ] **Step 5: Run the full verification**

Run: `pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint scripts src tests`
Expected: all tests PASS (baseline 63 + Task 1's file + the new case; existing artifact cases green because they assert `.code` only); tsc exit 0; eslint 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/validation/artifact.ts src/lib/validation/index.ts tests/validation/artifact.test.ts
git commit -m "Refactor artifact tierCapacity onto the capacity oracle + export the seam"
```

---

## Self-Review

**Spec coverage (design doc §-by-§):**
- Reframing — `Build.artifact` flat, no model rework → Global Constraints + both tasks touch neither `build.ts` nor synergy. ✓
- Module `src/lib/validation/artifact-capacity.ts`, pure → Task 1 create + Global Constraints. ✓
- API `buildCapacityModel` / `evaluate` / `canAdd` with the confirmed precompute+fast-eval shape → Task 1 Step 3. ✓
- Semantics 1 (`feasible` = not-over; partial feasible) → Task 1 partial + completeness tests. ✓
- Semantics 2 (`headroomByTier[k]` formula; `feasible` iff all ≥ 0; `canAdd` = min over k≤t) → Task 1 impl + `canAdd` tests. ✓
- Semantics 3 (only placeable perks; unknown/name-only ignored) → Task 1 dedup/unknown test + `placeable` filter. ✓
- Semantics 4 (`UNDERFILLED` stays validator-only) → Task 2 rule keeps UNDERFILLED; oracle has no such notion. ✓
- Refactor: `tierCapacity` thin adapter, no behavior change for covered cases, `perkMembership` untouched → Task 2 Steps 3, existing tests green. ✓
- Correctness: completeness vs. matching reference → Task 1 512-subset test. ✓
- Testing (unit + integration + regression) → Task 1 unit + completeness; Task 2 full-suite run (which includes the existing real-dataset `tests/validation/integration.test.ts`) + new over-constrained case. ✓
- Out of scope (OAuth, champions, solver's use) → not built. ✓

**Behavior-change note (intentional, documented):** for a selection that is simultaneously infeasible AND under total count (e.g. three perks all native to a 2-socket top tier, `[7,8,9]` on artifact `600`), the old rule emitted BOTH `ARTIFACT_TIER_UNDERFILLED` and a nested `ARTIFACT_TIER_OVER_CAP`; the refactor emits `OVER_CAP` only. This is a strict improvement (the two are contradictory), it is not covered by any existing test, and Task 2 Step 1 adds an explicit test pinning the new single-violation behavior. All existing artifact test cases are unaffected.

**Placeholder scan:** No TBD/TODO; every code step contains complete code and exact commands. ✓

**Type consistency:** `CapacityModel { nativeTier, socketsByTier, capacity }`, `Capacity { feasible, selected, capacity, headroomByTier }`, `buildCapacityModel(artifact)`, `evaluate(model, selectedHashes)`, `canAdd(model, cap, nativeTier)` used identically in Task 1 (definition + tests) and Task 2 (import + re-export aliases `evaluateArtifactCapacity`/`canAddArtifactPerk`). Violation codes (`ARTIFACT_TIER_OVER_CAP`/`ARTIFACT_TIER_UNDERFILLED`) match the existing `ViolationCode` union. ✓
