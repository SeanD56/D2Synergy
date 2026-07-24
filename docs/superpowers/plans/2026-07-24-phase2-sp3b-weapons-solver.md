# SP3b (slice 1) — Weapons solver: perk-roll membership + roll selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the SP3a beam solver to also select each open weapon slot's weapon *and* its full roll (one plug per unpinned column), constrained by perk-roll membership, column co-occurrence, and no-double-Primary ammo legality, ranked by synergy.

**Architecture:** Additive extension of the SP3a beam — weapon selection is one addable move that unlocks per-column plug moves (staged incremental), all in one joint beam over all open weapon slots. Roll synergy is recovered by a plug-NAME bridge to tagged sandbox perks (Option B), because weapon plug hashes are a disjoint namespace from `perks.json`. SP3a's `synergyUpperBound` is reused verbatim; the open-slot bound feeds it a precomputed per-slot reachable-union of tags.

**Tech Stack:** TypeScript (strict), Vitest, ESLint. Pure/dependency-injected `src/lib/solver` (no filesystem), reaching synergy only through the `@/lib/synergy` seam.

## Global Constraints

- **Layering is one-way:** nothing in `@/lib/validation` or `@/lib/synergy` imports from `@/lib/solver`. The solver may import from both.
- **Solver purity:** no filesystem, no `Date.now()`/`Math.random()`. All data via injected `Lookup` + `Indexes`.
- **Determinism:** all candidate ordering is by ascending hash; beam tie-break is `priority || realized.score || key` (SP3a's rule, unchanged).
- **Synergy seam:** the solver reaches synergy only via `scoreSynergy` / `getSynergies` / `synergyUpperBound`. The name bridge lives in `@/lib/synergy` (`collectBuildElements`) + `@/lib/validation` (`Lookup.perkByName`), never in the solver.
- **Green gate every task:** `npx tsc --noEmit` exit 0, `npx eslint scripts src tests` exit 0, `npx vitest run` all pass, before every commit.
- **Do NOT re-run ingest.** Weapon-plug hash-tagging (Option A) is deferred to the next legitimate re-ingest; this slice uses the runtime name bridge only.

**Spec:** `docs/superpowers/specs/2026-07-24-phase2-sp3b-weapons-solver-design.md`

---

## File structure

- `src/lib/validation/types.ts` — add `perkByName` to the `Lookup` interface (Task 1).
- `src/lib/validation/lookup.ts` — implement `perkByName` (Task 1).
- `src/lib/validation/weapons.ts` — export `columnsFor` for reuse (Task 2).
- `src/lib/validation/index.ts` — re-export `columnsFor` (Task 2).
- `src/lib/synergy/elements.ts` — name-resolution fallback for weapon `perkConstraints` (Task 1).
- `src/lib/solver/weapons.ts` — **new**: `LegalWeapon`, `deriveWeaponPool`, `deriveWeaponSlotReach`, `nonPowerAmmoInfeasible` (Tasks 2, 3, 5).
- `src/lib/solver/candidates.ts` — extend `Candidate` + `generateCandidates` with weapon/plug moves (Task 4).
- `src/lib/solver/beam.ts` — `WeaponPick`, env weapon fields, `makeState`/`stateKey`/`expand` extended (Tasks 3, 5).
- `src/lib/solver/index.ts` — export new public types if any (Task 6).
- Tests under `tests/synergy/`, `tests/validation/`, `tests/solver/`.

---

### Task 1: Plug-name synergy bridge (`Lookup.perkByName` + `collectBuildElements` fallback)

**Files:**
- Modify: `src/lib/validation/types.ts` (Lookup interface)
- Modify: `src/lib/validation/lookup.ts` (implement perkByName)
- Modify: `src/lib/synergy/elements.ts:30-34` (name fallback)
- Test: `tests/validation/lookup.test.ts` (perkByName), `tests/synergy/elements-weapon-bridge.test.ts` (new), `tests/synergy/weapon-curated-resolution.test.ts` (new, real data)

**Interfaces:**
- Produces: `Lookup.perkByName(name: string): Perk | undefined` — returns a tagged sandbox `Perk` whose (case-insensitive) name matches, preferring perks with non-empty synergy tags; deterministic on collision (first in dataset order).
- Produces: `collectBuildElements` now resolves a weapon `perkConstraint` via `lookup.perk(perkHash)` first, then `lookup.perkByName(perkName)`.

- [ ] **Step 1: Write the failing test for `perkByName`**

In `tests/validation/lookup.test.ts`, add (adapt the existing dataset-building helper in that file to include two perks):

```ts
it("perkByName resolves case-insensitively, preferring tagged perks", () => {
  const dataset = makeDataset({
    perks: [
      { kind: "perk", hash: 10, name: "Voltshot", icon: "", description: "",
        tags: { produces: ["jolt"], consumes: [], triggers: [] } },
      { kind: "perk", hash: 11, name: "Arrowhead Brake", icon: "", description: "",
        tags: { produces: [], consumes: [], triggers: [] } },
    ],
  });
  const lookup = createLookup(dataset);
  expect(lookup.perkByName("voltshot")?.hash).toBe(10);
  expect(lookup.perkByName("Arrowhead Brake")?.hash).toBe(11);
  expect(lookup.perkByName("nope")).toBeUndefined();
});
```

If `tests/validation/lookup.test.ts` has no `makeDataset` helper, build the dataset inline mirroring the existing tests in that file (only `perks` needs entries; other arrays can be `[]`, `indexes` the empty-index literal the file already uses).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/validation/lookup.test.ts -t perkByName`
Expected: FAIL — `lookup.perkByName is not a function`.

- [ ] **Step 3: Add `perkByName` to the `Lookup` interface**

In `src/lib/validation/types.ts`, inside `interface Lookup`, after the `perk(hash: Hash): Perk | undefined;` line add:

```ts
  /** Resolve a (sandbox) perk by case-insensitive name — the weapon plug-name bridge. */
  perkByName(name: string): Perk | undefined;
```

- [ ] **Step 4: Implement `perkByName` in `createLookup`**

In `src/lib/validation/lookup.ts`, after the `const perks = indexByHash(dataset.perks);` line add:

```ts
  const nonEmptyTags = (p: { tags: { produces: string[]; consumes: string[]; triggers: string[] } }) =>
    p.tags.produces.length > 0 || p.tags.consumes.length > 0 || p.tags.triggers.length > 0;
  const perksByName = new Map<string, (typeof dataset.perks)[number]>();
  for (const p of dataset.perks) {
    const key = p.name.toLowerCase();
    const existing = perksByName.get(key);
    // Prefer the first tagged perk for a name; otherwise keep the first seen.
    if (!existing || (!nonEmptyTags(existing) && nonEmptyTags(p))) perksByName.set(key, p);
  }
```

Then in the returned object, after `perk: (hash) => perks.get(hash),` add:

```ts
    perkByName: (name) => perksByName.get(name.toLowerCase()),
```

- [ ] **Step 5: Run the `perkByName` test to verify it passes**

Run: `npx vitest run tests/validation/lookup.test.ts -t perkByName`
Expected: PASS.

- [ ] **Step 6: Write the failing test for the `collectBuildElements` name fallback**

Create `tests/synergy/elements-weapon-bridge.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import type { Build, DerivedDataset } from "@/lib/types";

import { collectBuildElements } from "@/lib/synergy/elements";

const EMPTY_INDEXES = {
  keyword: { producers: {}, consumers: {} },
  perkToWeapons: {}, elementToItems: {}, setToPieces: {},
  exoticToClassSlot: {}, slotToWeapons: {},
};

function datasetWith(partial: Partial<DerivedDataset>): DerivedDataset {
  return {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [], fragments: [], weapons: [], armor: [],
    armorSets: [], mods: [], artifacts: [], perks: [], stats: [],
    indexes: EMPTY_INDEXES as DerivedDataset["indexes"], ...partial,
  } as DerivedDataset;
}

describe("collectBuildElements weapon plug-name bridge", () => {
  it("resolves a weapon perkConstraint by name when the hash misses lookup.perk", () => {
    const dataset = datasetWith({
      weapons: [{
        kind: "weapon", hash: 500, name: "Test AR", icon: "",
        slot: "kinetic", damageType: "kinetic", ammoType: "primary",
        perkColumns: [{ socketIndex: 0, plugs: [{ hash: 900, name: "Voltshot" }] }],
        tags: { produces: [], consumes: [], triggers: [], element: "kinetic" },
      }],
      perks: [{
        kind: "perk", hash: 42, name: "Voltshot", icon: "", description: "",
        tags: { produces: ["jolt"], consumes: [], triggers: [] },
      }],
    });
    const lookup = createLookup(dataset);
    const build = {
      subclass: { element: "arc", aspectHashes: [], fragmentHashes: [] },
      weapons: [{ slot: "kinetic", itemHash: 500,
        // plug hash 900 does NOT resolve via lookup.perk; name "Voltshot" does.
        perkConstraints: [{ perkHash: 900, perkName: "Voltshot", column: 0 }] }],
      armor: { modHashes: [] },
      artifact: { selectedPerkHashes: [] },
    } as unknown as Build;

    const els = collectBuildElements(build, lookup);
    const voltshot = els.find((e) => e.source === "perk:Voltshot");
    expect(voltshot?.tags.produces).toEqual(["jolt"]);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run tests/synergy/elements-weapon-bridge.test.ts`
Expected: FAIL — no element with `source === "perk:Voltshot"` (the plug hash 900 misses `lookup.perk`, and there is no name fallback yet).

- [ ] **Step 8: Add the name fallback in `collectBuildElements`**

In `src/lib/synergy/elements.ts`, replace the weapon `perkConstraints` loop (currently lines 30-34):

```ts
    for (const c of w.perkConstraints) {
      if (c.perkHash === undefined) continue; // name-only constraints unresolved in v1
      const p = lookup.perk(c.perkHash);
      if (p) add(p.hash, `perk:${p.name}`, p.tags);
    }
```

with:

```ts
    for (const c of w.perkConstraints) {
      // Resolve by hash first (future ingest may hash-tag plugs); otherwise fall
      // back to the plug-NAME bridge (v1: weapon plug hashes are disjoint from the
      // sandbox-perk namespace, so only the name resolves a tagged Perk).
      const p =
        (c.perkHash !== undefined ? lookup.perk(c.perkHash) : undefined) ??
        (c.perkName !== undefined ? lookup.perkByName(c.perkName) : undefined);
      if (p) add(p.hash, `perk:${p.name}`, p.tags);
    }
```

- [ ] **Step 9: Run the bridge test to verify it passes**

Run: `npx vitest run tests/synergy/elements-weapon-bridge.test.ts`
Expected: PASS.

- [ ] **Step 10: Write the curated-resolution test (real data)**

Create `tests/synergy/weapon-curated-resolution.test.ts`:

```ts
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
```

- [ ] **Step 11: Run the curated test to verify it passes**

Run: `npx vitest run tests/synergy/weapon-curated-resolution.test.ts`
Expected: PASS (all 5 traits resolve — verified against committed data 2026-07-24).

- [ ] **Step 12: Run the full green gate**

Run: `npx tsc --noEmit && npx eslint scripts src tests && npx vitest run`
Expected: tsc exit 0, eslint exit 0, all tests pass.

- [ ] **Step 13: Commit**

```bash
git add src/lib/validation/types.ts src/lib/validation/lookup.ts src/lib/synergy/elements.ts tests/validation/lookup.test.ts tests/synergy/elements-weapon-bridge.test.ts tests/synergy/weapon-curated-resolution.test.ts
git commit -m "feat(synergy): weapon plug-name bridge (perkByName + collectBuildElements fallback)"
```

---

### Task 2: Weapon membership pool (`deriveWeaponPool`)

**Files:**
- Modify: `src/lib/validation/weapons.ts` (export `columnsFor`)
- Modify: `src/lib/validation/index.ts` (re-export `columnsFor`)
- Create: `src/lib/solver/weapons.ts`
- Test: `tests/solver/weapons-pool.test.ts`

**Interfaces:**
- Consumes: `columnsFor(columns: WeaponPerkColumn[], constraint: PerkConstraint): WeaponPerkColumn[]` (from `@/lib/validation`); `SolverContext` (`{ lookup, indexes }` from `./types`); `indexes.slotToWeapons`.
- Produces:
  ```ts
  interface LegalWeapon {
    weapon: Weapon;
    /** Columns the solver must fill: perkColumns minus pin-locked columns. */
    openColumns: WeaponPerkColumn[];
  }
  function deriveWeaponPool(ctx: SolverContext, slot: WeaponSlot, pins: PerkConstraint[]): LegalWeapon[];
  ```
  Membership-filtered (a pin with no column ⇒ weapon excluded), pin-column-conflict-filtered (two pins forced to the same only-column ⇒ excluded), hash-sorted.

- [ ] **Step 1: Write the failing test**

Create `tests/solver/weapons-pool.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import type { DerivedDataset, Weapon } from "@/lib/types";

import { deriveWeaponPool } from "@/lib/solver/weapons";
import type { SolverContext } from "@/lib/solver";

const EMPTY_INDEXES = {
  keyword: { producers: {}, consumers: {} },
  perkToWeapons: {}, elementToItems: {}, setToPieces: {},
  exoticToClassSlot: {}, slotToWeapons: {},
};

function weapon(hash: number, name: string, cols: Array<Array<[number, string]>>): Weapon {
  return {
    kind: "weapon", hash, name, icon: "", slot: "kinetic",
    damageType: "kinetic", ammoType: "primary",
    perkColumns: cols.map((plugs, i) => ({
      socketIndex: i, plugs: plugs.map(([h, n]) => ({ hash: h, name: n })),
    })),
    tags: { produces: [], consumes: [], triggers: [], element: "kinetic" },
  };
}

function ctxWith(weapons: Weapon[]): SolverContext {
  const dataset = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [], fragments: [], weapons, armor: [],
    armorSets: [], mods: [], artifacts: [], perks: [], stats: [],
    indexes: {
      ...EMPTY_INDEXES,
      slotToWeapons: { kinetic: weapons.map((w) => w.hash) },
    },
  } as unknown as DerivedDataset;
  return { lookup: createLookup(dataset), indexes: dataset.indexes };
}

describe("deriveWeaponPool", () => {
  const wByHash = (pool: { weapon: { hash: number } }[], h: number) =>
    pool.find((l) => l.weapon.hash === h);

  it("no pins → every slot weapon is legal, all columns open, hash-sorted", () => {
    const ctx = ctxWith([
      weapon(20, "B", [[[1, "x"]]]),
      weapon(10, "A", [[[1, "x"]], [[2, "y"]]]),
    ]);
    const pool = deriveWeaponPool(ctx, "kinetic", []);
    expect(pool.map((l) => l.weapon.hash)).toEqual([10, 20]);
    expect(wByHash(pool, 10)!.openColumns).toHaveLength(2);
  });

  it("excludes a weapon that cannot roll a pinned perk", () => {
    const ctx = ctxWith([
      weapon(10, "has", [[[1, "Voltshot"]]]),
      weapon(20, "hasnt", [[[9, "Other"]]]),
    ]);
    const pool = deriveWeaponPool(ctx, "kinetic", [{ perkName: "Voltshot" }]);
    expect(pool.map((l) => l.weapon.hash)).toEqual([10]);
  });

  it("pins lock their column: openColumns excludes a single-column pin's column", () => {
    const ctx = ctxWith([weapon(10, "w", [[[1, "Voltshot"]], [[2, "y"]]])]);
    const pool = deriveWeaponPool(ctx, "kinetic", [{ perkName: "Voltshot" }]);
    expect(pool[0].openColumns.map((c) => c.socketIndex)).toEqual([1]);
  });

  it("excludes a weapon where two pins are forced into the same only-column", () => {
    const ctx = ctxWith([weapon(10, "w", [[[1, "A"], [2, "B"]], [[3, "z"]]])]);
    // Both A and B live only in column 0 → cannot co-roll.
    const pool = deriveWeaponPool(ctx, "kinetic", [{ perkName: "A" }, { perkName: "B" }]);
    expect(pool).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/solver/weapons-pool.test.ts`
Expected: FAIL — `deriveWeaponPool` not exported / module `@/lib/solver/weapons` not found.

- [ ] **Step 3: Export `columnsFor` from the validator**

In `src/lib/validation/weapons.ts`, change `function columnsFor(` to `export function columnsFor(`.

In `src/lib/validation/index.ts`, after the `export { createLookup } from "./lookup";` line add:

```ts
export { columnsFor } from "./weapons";
```

- [ ] **Step 4: Implement `deriveWeaponPool`**

Create `src/lib/solver/weapons.ts`:

```ts
import type { PerkConstraint, Weapon, WeaponPerkColumn, WeaponSlot } from "@/lib/types";

import { columnsFor } from "@/lib/validation";

import type { SolverContext } from "./types";

/** A slot weapon that can satisfy the pins, with the columns the solver must fill. */
export interface LegalWeapon {
  weapon: Weapon;
  /** perkColumns minus the columns locked by single-resolvable pins. */
  openColumns: WeaponPerkColumn[];
}

/**
 * Assign each pin to a concrete column (its lowest-index legal column not already
 * taken), or return null if any pin cannot be placed (PERK_NOT_IN_POOL) or two pins
 * collide on a column (PERK_COLUMN_CONFLICT). Pins are placed fewest-options-first so
 * a tightly-constrained pin claims its column before a flexible one — a small greedy
 * matching (v1: exact bipartite matching is deferred; pins per slot are few).
 */
function lockedColumns(weapon: Weapon, pins: PerkConstraint[]): Set<number> | null {
  const options = pins
    .filter((p) => p.perkHash !== undefined || p.perkName !== undefined)
    .map((p) => columnsFor(weapon.perkColumns, p).map((c) => c.socketIndex).sort((a, b) => a - b))
    .sort((a, b) => a.length - b.length);
  const taken = new Set<number>();
  for (const cols of options) {
    if (cols.length === 0) return null; // pin not in pool
    const pick = cols.find((idx) => !taken.has(idx));
    if (pick === undefined) return null; // collision: every legal column already taken
    taken.add(pick);
  }
  return taken;
}

/** Slot weapons that can satisfy the pins, hash-sorted, each with its open columns. */
export function deriveWeaponPool(
  ctx: SolverContext,
  slot: WeaponSlot,
  pins: PerkConstraint[],
): LegalWeapon[] {
  const hashes = ctx.indexes.slotToWeapons[slot] ?? [];
  const out: LegalWeapon[] = [];
  const seen = new Set<number>();
  for (const h of hashes) {
    if (seen.has(h)) continue;
    seen.add(h);
    const weapon = ctx.lookup.weapon(h);
    if (!weapon || weapon.slot !== slot) continue;
    const locked = lockedColumns(weapon, pins);
    if (locked === null) continue;
    out.push({
      weapon,
      openColumns: weapon.perkColumns.filter((c) => !locked.has(c.socketIndex)),
    });
  }
  return out.sort((a, b) => a.weapon.hash - b.weapon.hash);
}
```

- [ ] **Step 5: Run the pool test to verify it passes**

Run: `npx vitest run tests/solver/weapons-pool.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 6: Green gate + commit**

```bash
npx tsc --noEmit && npx eslint scripts src tests && npx vitest run
git add src/lib/validation/weapons.ts src/lib/validation/index.ts src/lib/solver/weapons.ts tests/solver/weapons-pool.test.ts
git commit -m "feat(solver): weapon membership pool (deriveWeaponPool) reusing columnsFor"
```

---

### Task 3: Reachable-union bound aggregate (`deriveWeaponSlotReach`) + env wiring

**Files:**
- Modify: `src/lib/solver/weapons.ts` (add `deriveWeaponSlotReach`)
- Modify: `src/lib/solver/beam.ts` (env weapon fields + open-slot detection + empty-pool infeasibility)
- Test: `tests/solver/weapons-reach.test.ts`, `tests/solver/beam.test.ts` (env feasibility)

**Interfaces:**
- Consumes: `LegalWeapon`, `deriveWeaponPool` (Task 2); `Lookup.perkByName` (Task 1); `BuildElement` (from `@/lib/synergy`).
- Produces:
  ```ts
  function deriveWeaponSlotReach(ctx: SolverContext, pool: LegalWeapon[]): BuildElement[];
  ```
  Deduped-by-hash union of every legal weapon's element-tag `BuildElement` plus every open-column plug resolved through the name bridge (`lookup.perkByName`). This is the loose over-estimate the open-slot bound feeds to `synergyUpperBound`.
- Produces (env additions on `SolverEnv`): `openWeaponSlots: WeaponSlot[]`, `weaponPool: Map<WeaponSlot, LegalWeapon[]>`, `weaponReach: Map<WeaponSlot, BuildElement[]>`.

- [ ] **Step 1: Write the failing test for `deriveWeaponSlotReach`**

Create `tests/solver/weapons-reach.test.ts` (reuse the `ctxWith`/`weapon` helpers by copying them into this file — keep test files self-contained):

```ts
import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import type { DerivedDataset, Perk, Weapon } from "@/lib/types";

import { deriveWeaponPool, deriveWeaponSlotReach } from "@/lib/solver/weapons";
import type { SolverContext } from "@/lib/solver";

const EMPTY_INDEXES = {
  keyword: { producers: {}, consumers: {} },
  perkToWeapons: {}, elementToItems: {}, setToPieces: {},
  exoticToClassSlot: {}, slotToWeapons: {},
};

function weapon(hash: number, name: string, plugNames: string[]): Weapon {
  return {
    kind: "weapon", hash, name, icon: "", slot: "kinetic",
    damageType: "kinetic", ammoType: "primary",
    perkColumns: [{ socketIndex: 0, plugs: plugNames.map((n, i) => ({ hash: 1000 + i, name: n })) }],
    tags: { produces: [], consumes: [], triggers: [], element: "kinetic" },
  };
}

function perk(hash: number, name: string, produces: string[]): Perk {
  return { kind: "perk", hash, name, icon: "", description: "",
    tags: { produces, consumes: [], triggers: [] } };
}

function ctxWith(weapons: Weapon[], perks: Perk[]): SolverContext {
  const dataset = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [], fragments: [], weapons, armor: [],
    armorSets: [], mods: [], artifacts: [], perks, stats: [],
    indexes: { ...EMPTY_INDEXES, slotToWeapons: { kinetic: weapons.map((w) => w.hash) } },
  } as unknown as DerivedDataset;
  return { lookup: createLookup(dataset), indexes: dataset.indexes };
}

describe("deriveWeaponSlotReach", () => {
  it("unions weapon element-tags + name-bridged plug tags across the whole pool", () => {
    const ctx = ctxWith(
      [weapon(10, "A", ["Voltshot", "Barrel"]), weapon(20, "B", ["Incandescent"])],
      [perk(42, "Voltshot", ["jolt"]), perk(43, "Incandescent", ["scorch"])],
    );
    const pool = deriveWeaponPool(ctx, "kinetic", []);
    const reach = deriveWeaponSlotReach(ctx, pool);
    const produced = reach.flatMap((e) => e.tags.produces);
    expect(produced).toContain("jolt");
    expect(produced).toContain("scorch");
    // "Barrel" has no tagged perk → contributes nothing, but must not crash.
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/solver/weapons-reach.test.ts`
Expected: FAIL — `deriveWeaponSlotReach` not exported.

- [ ] **Step 3: Implement `deriveWeaponSlotReach`**

In `src/lib/solver/weapons.ts`, add imports and the function:

```ts
import type { BuildElement } from "@/lib/synergy";
```

```ts
/**
 * Loose reachable-union of tagged elements for a slot: every legal weapon's own
 * element-tags plus every open-column plug resolved through the name bridge. Deduped
 * by hash. An over-estimate (a slot yields one weapon + one plug per column, not all)
 * — safe for an admissible bound. Static per (slot, pins); compute once and cache.
 */
export function deriveWeaponSlotReach(ctx: SolverContext, pool: LegalWeapon[]): BuildElement[] {
  const out: BuildElement[] = [];
  const seen = new Set<number>();
  const add = (hash: number, source: string, tags: BuildElement["tags"]) => {
    if (seen.has(hash)) return;
    seen.add(hash);
    out.push({ hash, source, tags });
  };
  for (const { weapon, openColumns } of pool) {
    add(weapon.hash, `weapon:${weapon.name}`, weapon.tags);
    for (const col of openColumns) {
      for (const plug of col.plugs) {
        const p = ctx.lookup.perkByName(plug.name);
        if (p) add(p.hash, `perk:${p.name}`, p.tags);
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the reach test to verify it passes**

Run: `npx vitest run tests/solver/weapons-reach.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for env open-slot feasibility**

In `tests/solver/beam.test.ts`, add a test that `buildSolverEnv` returns `null` when an open weapon slot has zero legal weapons. Use the file's existing env-building helper/dataset; add an open weapon slot whose `slotToWeapons` is empty (or whose only weapon fails a pin):

```ts
it("buildSolverEnv is infeasible when an open weapon slot has no legal weapon", () => {
  const base = baseBuild({
    weapons: [{ slot: "kinetic", itemHash: undefined, perkConstraints: [{ perkName: "Nonexistent" }] }],
  });
  // ctx has at least one kinetic weapon in slotToWeapons, but none can roll "Nonexistent".
  expect(buildSolverEnv(base, ctx)).toBeNull();
});
```

Adapt `baseBuild`/`ctx` to the helpers already present in `tests/solver/beam.test.ts`. If that file builds its ctx without any weapons, add one kinetic weapon (that lacks the pinned perk) to its dataset so the pool is non-empty-input but membership-empty.

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run tests/solver/beam.test.ts -t "no legal weapon"`
Expected: FAIL — `buildSolverEnv` currently ignores weapons and returns a non-null env.

- [ ] **Step 7: Wire weapon fields into `SolverEnv` and `buildSolverEnv`**

In `src/lib/solver/beam.ts`:

Add imports:

```ts
import type { PerkConstraint, WeaponSlot } from "@/lib/types";
import type { BuildElement } from "@/lib/synergy";
import { deriveWeaponPool, deriveWeaponSlotReach, type LegalWeapon } from "./weapons";
```

Extend `interface SolverEnv` with:

```ts
  /** Weapon slots the solver must fill (itemHash undefined in the base). */
  openWeaponSlots: WeaponSlot[];
  /** Membership-filtered legal weapons per open slot. */
  weaponPool: Map<WeaponSlot, LegalWeapon[]>;
  /** Precomputed loose reachable-union per open slot (for the open-slot bound). */
  weaponReach: Map<WeaponSlot, BuildElement[]>;
```

In `buildSolverEnv`, before the `return {` statement, compute the weapon fields and add the infeasibility check:

```ts
  const openWeaponSlots: WeaponSlot[] = [];
  const weaponPool = new Map<WeaponSlot, LegalWeapon[]>();
  const weaponReach = new Map<WeaponSlot, BuildElement[]>();
  for (const sel of base.weapons) {
    if (sel.itemHash !== undefined) continue; // pinned slot — not searched
    const pins: PerkConstraint[] = sel.perkConstraints;
    const pool = deriveWeaponPool(ctx, sel.slot, pins);
    if (pool.length === 0) return null; // no weapon can satisfy this slot's pins
    openWeaponSlots.push(sel.slot);
    weaponPool.set(sel.slot, pool);
    weaponReach.set(sel.slot, deriveWeaponSlotReach(ctx, pool));
  }
```

Then add `openWeaponSlots, weaponPool, weaponReach,` to the returned env object.

- [ ] **Step 8: Run the env feasibility test + full beam suite**

Run: `npx vitest run tests/solver/beam.test.ts`
Expected: PASS — the new infeasibility test passes and all pre-existing SP3a beam tests still pass (weapon fields default to empty when no open weapon slots).

- [ ] **Step 9: Green gate + commit**

```bash
npx tsc --noEmit && npx eslint scripts src tests && npx vitest run
git add src/lib/solver/weapons.ts src/lib/solver/beam.ts tests/solver/weapons-reach.test.ts tests/solver/beam.test.ts
git commit -m "feat(solver): weapon slot reach aggregate + env wiring (open-slot feasibility)"
```

---

### Task 4: Weapon + plug candidate generation

**Files:**
- Modify: `src/lib/solver/candidates.ts` (extend `Candidate` + `generateCandidates`)
- Modify: `src/lib/solver/beam.ts` (pass weapon state + env into `generateCandidates`)
- Test: `tests/solver/candidates-weapons.test.ts`

**Interfaces:**
- Consumes: `SolverEnv` weapon fields (Task 3); `WeaponPick` (defined here, used by Task 5).
- Produces:
  ```ts
  interface WeaponPick { slot: WeaponSlot; itemHash: Hash; plugHashes: Hash[]; }
  ```
  (exported from `./beam` in Task 5; declared here as the candidate-gen input shape — define it in `beam.ts` in Task 5 and import it, OR define in `candidates.ts` and re-export. To avoid a cycle, DEFINE `WeaponPick` in `candidates.ts` and import it into `beam.ts`.)
- Produces: `Candidate` gains `kind: "weapon" | "weaponPerk"`, optional `slot?: WeaponSlot`, `column?: number`. `generateCandidates` gains a `weaponEnv` + `weaponPicks` parameter and appends weapon-selection candidates (open slots with no pick) and plug candidates (picked slots' unfilled open columns).

- [ ] **Step 1: Write the failing test**

Create `tests/solver/candidates-weapons.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import type { DerivedDataset, Perk, Weapon } from "@/lib/types";

import { deriveWeaponPool, deriveWeaponSlotReach } from "@/lib/solver/weapons";
import { generateCandidates, type WeaponPick } from "@/lib/solver/candidates";
import type { SolverContext } from "@/lib/solver";

// (copy EMPTY_INDEXES, weapon(), perk(), ctxWith() helpers from weapons-reach.test.ts)

// Minimal weaponEnv shape generateCandidates needs (structural subset of SolverEnv).
function weaponEnv(ctx: SolverContext) {
  const pool = deriveWeaponPool(ctx, "kinetic", []);
  return {
    fragmentPool: [], perkPool: [], fragmentCap: 0,
    capModel: { nativeTier: new Map(), tiers: [] } as never,
    openWeaponSlots: ["kinetic" as const],
    weaponPool: new Map([["kinetic", pool]]),
    weaponReach: new Map([["kinetic", deriveWeaponSlotReach(ctx, pool)]]),
  };
}

describe("generateCandidates — weapons", () => {
  it("offers each legal weapon for an open slot with no pick", () => {
    const ctx = ctxWith([weapon(10, "A", ["Voltshot"]), weapon(20, "B", ["Barrel"])], [perk(42, "Voltshot", ["jolt"])]);
    const cands = generateCandidates(weaponEnv(ctx), [], [], { tier: 0 } as never, []);
    const weapons = cands.filter((c) => c.kind === "weapon");
    expect(weapons.map((c) => c.hash)).toEqual([10, 20]);
    expect(weapons[0].slot).toBe("kinetic");
  });

  it("offers one plug per unfilled open column once a weapon is picked", () => {
    const ctx = ctxWith([weapon(10, "A", ["Voltshot"])], [perk(42, "Voltshot", ["jolt"])]);
    const picks: WeaponPick[] = [{ slot: "kinetic", itemHash: 10, plugHashes: [] }];
    const cands = generateCandidates(weaponEnv(ctx), [], [], { tier: 0 } as never, picks);
    const plugs = cands.filter((c) => c.kind === "weaponPerk");
    expect(plugs).toHaveLength(1);
    expect(plugs[0].hash).toBe(1000); // Voltshot's plug hash (1000 + index 0)
    expect(plugs[0].element.tags.produces).toContain("jolt"); // name-bridged
    // no weapon candidate for a slot that already has a pick
    expect(cands.some((c) => c.kind === "weapon")).toBe(false);
  });

  it("offers no plug for a fully-rolled slot (all open columns filled)", () => {
    const ctx = ctxWith([weapon(10, "A", ["Voltshot"])], [perk(42, "Voltshot", ["jolt"])]);
    const picks: WeaponPick[] = [{ slot: "kinetic", itemHash: 10, plugHashes: [1000] }];
    const cands = generateCandidates(weaponEnv(ctx), [], [], { tier: 0 } as never, picks);
    expect(cands).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/solver/candidates-weapons.test.ts`
Expected: FAIL — `WeaponPick` not exported; `generateCandidates` arity/behavior mismatch.

- [ ] **Step 3: Extend `Candidate`, define `WeaponPick`, and extend `generateCandidates`**

In `src/lib/solver/candidates.ts`:

Add imports:

```ts
import type { WeaponSlot } from "@/lib/types";
import type { LegalWeapon } from "./weapons";
```

Extend the `Candidate` interface:

```ts
export interface Candidate {
  kind: "fragment" | "artifactPerk" | "weapon" | "weaponPerk";
  hash: Hash;
  nativeTier?: number;
  /** Weapon slot — present for "weapon" and "weaponPerk" moves. */
  slot?: WeaponSlot;
  /** Target column socketIndex — present for "weaponPerk" moves. */
  column?: number;
  element: BuildElement;
}
```

Add the `WeaponPick` type and extend `CandidateEnv`:

```ts
/** A weapon being filled in an open slot: chosen weapon + plugs chosen so far. */
export interface WeaponPick {
  slot: WeaponSlot;
  itemHash: Hash;
  /** Chosen plug hashes (⊆ the weapon's open columns), in the order added. */
  plugHashes: Hash[];
}

interface CandidateEnv {
  fragmentPool: Fragment[];
  perkPool: ArtifactPerk[];
  fragmentCap: number;
  capModel: CapacityModel;
  openWeaponSlots: WeaponSlot[];
  weaponPool: Map<WeaponSlot, LegalWeapon[]>;
}
```

Extend the `generateCandidates` signature and append weapon logic. Change the signature to:

```ts
export function generateCandidates(
  env: CandidateEnv,
  fragHashes: Hash[],
  perkHashes: Hash[],
  cap: Capacity,
  weaponPicks: WeaponPick[],
): Candidate[] {
```

Then, before the final `return out;`, insert:

```ts
  const pickBySlot = new Map(weaponPicks.map((p) => [p.slot, p]));
  for (const slot of env.openWeaponSlots) {
    const pick = pickBySlot.get(slot);
    if (!pick) {
      // No weapon chosen yet → offer each legal weapon (hash-sorted by the pool).
      for (const { weapon } of env.weaponPool.get(slot) ?? []) {
        out.push({ kind: "weapon", hash: weapon.hash, slot,
          element: { hash: weapon.hash, source: `weapon:${weapon.name}`, tags: weapon.tags } });
      }
      continue;
    }
    // Weapon chosen → offer one plug per still-unfilled open column.
    const legal = (env.weaponPool.get(slot) ?? []).find((l) => l.weapon.hash === pick.itemHash);
    if (!legal) continue;
    const chosen = new Set(pick.plugHashes);
    for (const col of legal.openColumns) {
      if (col.plugs.some((p) => chosen.has(p.hash))) continue; // column already filled
      for (const plug of col.plugs) {
        out.push({ kind: "weaponPerk", hash: plug.hash, slot, column: col.socketIndex,
          element: weaponPlugElement(pick.itemHash, plug) });
      }
    }
  }
```

Add a helper at the bottom of the file (imports `SolverContext`? No — it needs the name bridge; pass tags via a resolver on env). To keep `generateCandidates` synchronous and lookup-free, resolve plug tags via a small resolver on the env. **Simpler:** give `CandidateEnv` a `resolvePlugTags(name: string) => KeywordTags` closure set in `buildSolverEnv`. Replace the `weaponPlugElement` call and add the field:

In `CandidateEnv` add:

```ts
  resolvePlugTags: (name: string) => import("@/lib/types").KeywordTags;
```

Actually import `KeywordTags` at top: `import type { KeywordTags, WeaponSlot } from "@/lib/types";` and type the field `resolvePlugTags: (name: string) => KeywordTags;`. Then define the element inline:

```ts
        out.push({ kind: "weaponPerk", hash: plug.hash, slot, column: col.socketIndex,
          element: { hash: plug.hash, source: `perk:${plug.name}`, tags: env.resolvePlugTags(plug.name) } });
```

Remove the `weaponPlugElement` helper reference. (The `weaponPerk` element's `hash` is the plug hash — its `source` uses the plug name so realized synergy in `collectBuildElements` matches by name bridge.)

- [ ] **Step 4: Provide `resolvePlugTags` from the env**

In `src/lib/solver/beam.ts`, extend `SolverEnv` with:

```ts
  /** Name-bridge resolver for weapon plug tags (empty tags if unmatched). */
  resolvePlugTags: (name: string) => import("@/lib/types").KeywordTags;
```

In `buildSolverEnv`, add before the `return`:

```ts
  const EMPTY_TAGS = { produces: [], consumes: [], triggers: [] } as const;
  const resolvePlugTags = (name: string) => ctx.lookup.perkByName(name)?.tags ?? EMPTY_TAGS;
```

and add `resolvePlugTags,` to the returned env. The `weaponEnv` test helper (Task 4 Step 1) must include `resolvePlugTags` — update that helper to add `resolvePlugTags: (n: string) => ctx.lookup.perkByName(n)?.tags ?? { produces: [], consumes: [], triggers: [] }`.

- [ ] **Step 5: Update the `generateCandidates` call site in `makeState`**

In `src/lib/solver/beam.ts`, the `makeState` call to `generateCandidates(env, frag, perk, cap)` will be updated in Task 5 to pass weapon picks. For now (to keep compilation green with the new required parameter), change it to:

```ts
  const candidates = generateCandidates(env, frag, perk, cap, []);
```

(Task 5 replaces the `[]` with the real picks.)

- [ ] **Step 6: Run the candidates-weapons test + full suite**

Run: `npx vitest run tests/solver/candidates-weapons.test.ts tests/solver/candidates.test.ts`
Expected: PASS — new weapon cases pass; existing SP3a candidate tests still pass (they now pass `[]` picks; if the existing tests call `generateCandidates` with 4 args, update those call sites to pass `[]` as the 5th arg and add the empty weapon fields to their env objects).

- [ ] **Step 7: Green gate + commit**

```bash
npx tsc --noEmit && npx eslint scripts src tests && npx vitest run
git add src/lib/solver/candidates.ts src/lib/solver/beam.ts tests/solver/candidates-weapons.test.ts tests/solver/candidates.test.ts
git commit -m "feat(solver): weapon + plug candidate generation (staged, name-bridged tags)"
```

---

### Task 5: Beam state, expansion, ammo prune, terminal, and open-slot bound

**Files:**
- Modify: `src/lib/solver/beam.ts` (`SolverState.weapons`, `stateKey`, `makeState`, `expand`, ammo prune, bound addable set)
- Modify: `src/lib/solver/weapons.ts` (add `nonPowerAmmoInfeasible`)
- Test: `tests/solver/weapons-ammo.test.ts`, `tests/solver/beam-weapons.test.ts`

**Interfaces:**
- Consumes: `WeaponPick` (from `./candidates`), `Candidate` kinds `weapon`/`weaponPerk`, env weapon fields + `weaponReach` + `resolvePlugTags`.
- Produces: `SolverState` gains `weapons: WeaponPick[]`. `makeState(env, fragHashes, perkHashes, bound, weaponPicks?: WeaponPick[])` — additive 5th param defaulting to `[]`. `stateKey(fragHashes, perkHashes, weaponPicks?)` — additive; appends a weapon segment only when picks are non-empty (SP3a keys stay byte-identical). `expand` emits weapon/plug successors and drops ammo-infeasible weapon moves.
- Produces: `nonPowerAmmoInfeasible(decided: Array<{ slot: WeaponSlot; ammoType: "primary"|"special"|"heavy" }>): boolean` — true iff both non-power slots (kinetic + energy) are decided and neither is Special (the sound eager-prune condition).

- [ ] **Step 1: Write the failing test for `nonPowerAmmoInfeasible`**

Create `tests/solver/weapons-ammo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nonPowerAmmoInfeasible } from "@/lib/solver/weapons";

describe("nonPowerAmmoInfeasible", () => {
  it("false when fewer than both non-power slots are decided", () => {
    expect(nonPowerAmmoInfeasible([{ slot: "kinetic", ammoType: "primary" }])).toBe(false);
  });
  it("true when kinetic + energy are both decided and both Primary", () => {
    expect(nonPowerAmmoInfeasible([
      { slot: "kinetic", ammoType: "primary" },
      { slot: "energy", ammoType: "primary" },
    ])).toBe(true);
  });
  it("false when one non-power slot is Special", () => {
    expect(nonPowerAmmoInfeasible([
      { slot: "kinetic", ammoType: "primary" },
      { slot: "energy", ammoType: "special" },
    ])).toBe(false);
  });
  it("ignores Power slots", () => {
    expect(nonPowerAmmoInfeasible([
      { slot: "kinetic", ammoType: "primary" },
      { slot: "power", ammoType: "heavy" },
    ])).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/solver/weapons-ammo.test.ts`
Expected: FAIL — `nonPowerAmmoInfeasible` not exported.

- [ ] **Step 3: Implement `nonPowerAmmoInfeasible`**

In `src/lib/solver/weapons.ts`, add:

```ts
/**
 * Sound eager-prune condition for the no-double-Primary rule: infeasible iff BOTH
 * non-power slots (kinetic, energy) are decided and neither uses Special ammo. A
 * state with a non-power slot still open is NOT pruned (it may yet supply a Special)
 * — soundness over tightness; the terminal build re-validates regardless.
 */
export function nonPowerAmmoInfeasible(
  decided: Array<{ slot: WeaponSlot; ammoType: "primary" | "special" | "heavy" }>,
): boolean {
  const nonPower = decided.filter((d) => d.slot !== "power");
  if (nonPower.length < 2) return false;
  return !nonPower.some((d) => d.ammoType === "special");
}
```

- [ ] **Step 4: Run the ammo test to verify it passes**

Run: `npx vitest run tests/solver/weapons-ammo.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing beam-weapons tests**

Create `tests/solver/beam-weapons.test.ts`. It drives `beamSearch` end-to-end over a small dataset with one open kinetic slot. Include: (a) a delayed-reward roll test — the synergy-optimal plug is not the lowest-hash — where the bound ON keeps it and a zero bound does not; (b) an ammo-prune test asserting a two-Primary kinetic+energy state never reaches `completed`; (c) a terminal-shape test asserting the returned build's `weapons[i].perkConstraints` carry the chosen plug's `{perkHash, perkName, column}`.

```ts
import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import { synergyUpperBound } from "@/lib/synergy";
import type { Build, DerivedDataset, Perk, Weapon } from "@/lib/types";

import { beamSearch, buildSolverEnv } from "@/lib/solver/beam";
import type { SolverContext } from "@/lib/solver";

// (copy EMPTY_INDEXES + builders; give weapons real perkColumns and a subclass+artifact
//  so buildSolverEnv is feasible — mirror the fixtures in tests/solver/beam.test.ts,
//  adding the open weapon slot. A consumer perk on a fragment + a producer plug on the
//  weapon creates the delayed-reward pair.)

// The zero bound must prune the delayed-reward roll; synergyUpperBound must retain it.
const ZERO_BOUND = () => 0;
```

Author the fixtures so that: the pinned subclass fragment *consumes* keyword `jolt`; the open kinetic weapon has two plugs in one open column — a low-hash plug with no tags and a higher-hash "Voltshot" plug that *produces* `jolt`. With `synergyUpperBound`, the beam must complete with the Voltshot plug (score > 0); with `ZERO_BOUND` and a beam width of 1, it must settle on the low-hash inert plug (the greedy-realized baseline). Assert both.

For the ammo test: two open slots (kinetic + energy), each pool a single Primary weapon; assert `beamSearch` returns no `completed` state (all terminal candidates are ammo-infeasible and pruned) — i.e. `completed.length === 0`.

For the terminal-shape test: one open kinetic slot, one weapon, one open column with one plug named "Voltshot"; assert the single completed build's `weapons[0].perkConstraints` contains `{ perkHash: <plugHash>, perkName: "Voltshot", column: 0 }`.

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run tests/solver/beam-weapons.test.ts`
Expected: FAIL — `SolverState` has no weapon dimension; `makeState`/`expand` ignore weapons; terminal builds lack weapon `perkConstraints`.

- [ ] **Step 7: Add the weapon dimension to `SolverState`, `stateKey`, `makeState`**

In `src/lib/solver/beam.ts`:

Import `WeaponPick`: `import { generateCandidates, type Candidate, type WeaponPick } from "./candidates";` (replace the existing candidates import).

Add to `interface SolverState`:

```ts
  /** Weapons chosen for open slots (pinned slots live in `build`). */
  weapons: WeaponPick[];
```

Replace `stateKey` with the additive form:

```ts
export function stateKey(fragHashes: Hash[], perkHashes: Hash[], weaponPicks: WeaponPick[] = []): string {
  const s = (xs: Hash[]) => [...xs].sort((a, b) => a - b).join(",");
  const base = `frag:${s(fragHashes)}|perk:${s(perkHashes)}`;
  if (weaponPicks.length === 0) return base; // SP3a keys unchanged (byte-identical)
  const wpn = [...weaponPicks]
    .sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0))
    .map((p) => `${p.slot}=${p.itemHash}[${s(p.plugHashes)}]`)
    .join(";");
  return `${base}|wpn:${wpn}`;
}
```

Replace `makeState` with the additive-5th-param form that also rebuilds `build.weapons`:

```ts
export function makeState(
  env: SolverEnv,
  fragHashes: Hash[],
  perkHashes: Hash[],
  bound: BoundFn,
  weaponPicks: WeaponPick[] = [],
): SolverState {
  const frag = [...fragHashes].sort((a, b) => a - b);
  const perk = [...perkHashes].sort((a, b) => a - b);
  const pickBySlot = new Map(weaponPicks.map((p) => [p.slot, p]));
  const weapons = env.base.weapons.map((sel) => {
    const pick = sel.itemHash === undefined ? pickBySlot.get(sel.slot) : undefined;
    if (!pick) return sel; // pinned slot, or open slot not yet given a weapon
    const weapon = env.lookup.weapon(pick.itemHash);
    const plugConstraints = pick.plugHashes.map((h) => {
      let name = "", column = -1;
      for (const col of weapon?.perkColumns ?? []) {
        const plug = col.plugs.find((p) => p.hash === h);
        if (plug) { name = plug.name; column = col.socketIndex; break; }
      }
      return { perkHash: h, perkName: name, column };
    });
    return { ...sel, itemHash: pick.itemHash, perkConstraints: [...sel.perkConstraints, ...plugConstraints] };
  });
  const build: Build = {
    ...env.base,
    subclass: { ...env.base.subclass, fragmentHashes: frag },
    artifact: { ...env.base.artifact, selectedPerkHashes: perk },
    weapons,
  };
  const cap = evaluateArtifactCapacity(env.capModel, perk);
  const realized = scoreSynergy(build, env.lookup);
  const candidates = generateCandidates(env, frag, perk, cap, weaponPicks);
  // Open-slot bound: augment the addable set with each not-yet-picked slot's precomputed
  // reachable-union (candidates alone under-cover a slot whose weapon isn't chosen yet).
  const addable = candidates
    .filter((c) => c.kind !== "weapon") // weapon-selection tags are covered by weaponReach
    .map((c) => c.element);
  for (const slot of env.openWeaponSlots) {
    if (!pickBySlot.has(slot)) addable.push(...(env.weaponReach.get(slot) ?? []));
  }
  const priority = bound(build, addable, env.lookup);
  return { build, fragHashes: frag, perkHashes: perk, cap, realized, candidates, priority,
    weapons: weaponPicks, key: stateKey(frag, perk, weaponPicks) };
}
```

- [ ] **Step 8: Extend `expand` with weapon/plug moves + ammo prune**

In `src/lib/solver/beam.ts`, add an ammo import: `import { deriveWeaponPool, deriveWeaponSlotReach, nonPowerAmmoInfeasible, type LegalWeapon } from "./weapons";` (extend the existing weapons import).

Replace `expand` with:

```ts
export function expand(state: SolverState, env: SolverEnv, bound: BoundFn): SolverState[] {
  const out: SolverState[] = [];
  for (const c of state.candidates) {
    if (c.kind === "fragment") {
      out.push(makeState(env, [...state.fragHashes, c.hash], state.perkHashes, bound, state.weapons));
    } else if (c.kind === "artifactPerk") {
      out.push(makeState(env, state.fragHashes, [...state.perkHashes, c.hash], bound, state.weapons));
    } else if (c.kind === "weapon") {
      // Choose a weapon for slot c.slot. Eager ammo prune: skip if it makes the
      // no-double-Primary rule unsatisfiable across all decided weapons.
      const decided = decidedAmmo(env, [...state.weapons, { slot: c.slot!, itemHash: c.hash, plugHashes: [] }]);
      if (nonPowerAmmoInfeasible(decided)) continue;
      out.push(makeState(env, state.fragHashes, state.perkHashes, bound,
        [...state.weapons, { slot: c.slot!, itemHash: c.hash, plugHashes: [] }]));
    } else { // weaponPerk
      const nextPicks = state.weapons.map((p) =>
        p.slot === c.slot ? { ...p, plugHashes: [...p.plugHashes, c.hash] } : p);
      out.push(makeState(env, state.fragHashes, state.perkHashes, bound, nextPicks));
    }
  }
  return out;
}

/** Ammo type of every DECIDED weapon (pinned base weapons + current picks). */
function decidedAmmo(env: SolverEnv, picks: SolverState["weapons"]) {
  const decided: Array<{ slot: import("@/lib/types").WeaponSlot; ammoType: "primary" | "special" | "heavy" }> = [];
  for (const sel of env.base.weapons) {
    if (sel.itemHash === undefined) continue;
    const w = env.lookup.weapon(sel.itemHash);
    if (w) decided.push({ slot: sel.slot, ammoType: w.ammoType });
  }
  for (const p of picks) {
    const w = env.lookup.weapon(p.itemHash);
    if (w) decided.push({ slot: p.slot, ammoType: w.ammoType });
  }
  return decided;
}
```

Note: the `beamSearch` root state call `makeState(env, env.base.subclass.fragmentHashes, env.base.artifact.selectedPerkHashes, bound)` needs no change — the 5th param defaults to `[]`.

**Amendment (accepted deviation, applied during execution):** `beamSearch` must route a state to `completed` ONLY when all open weapon slots are decided — `state.weapons.length === env.openWeaponSlots.length`. Without this guard, an ammo-pruned dead-end (every remaining weapon candidate for an open slot is `continue`d, leaving `expand` with empty kids) is misclassified as terminal and leaks an INCOMPLETE build (undecided weapon slot) into `completed`. The guard is a provable no-op for SP3a (empty `openWeaponSlots` ⇒ condition always true) and never rejects a genuine terminal (all slots decided + all columns filled). Opus-verified during Task 5 review.

- [ ] **Step 9: Run the beam-weapons tests + full suite**

Run: `npx vitest run tests/solver/beam-weapons.test.ts tests/solver/beam.test.ts`
Expected: PASS — delayed-reward roll retained under `synergyUpperBound` and pruned under `ZERO_BOUND`; ammo-infeasible two-Primary state never completes; terminal build carries the plug constraints. All SP3a beam tests still pass.

- [ ] **Step 10: Green gate + commit**

```bash
npx tsc --noEmit && npx eslint scripts src tests && npx vitest run
git add src/lib/solver/beam.ts src/lib/solver/weapons.ts tests/solver/weapons-ammo.test.ts tests/solver/beam-weapons.test.ts
git commit -m "feat(solver): weapon beam state, staged expansion, ammo eager-prune, terminal roll"
```

---

### Task 6: `solve` output + real-data integration

**Files:**
- Modify: `src/lib/solver/index.ts` (export `WeaponPick`, `LegalWeapon` if part of the public surface — otherwise leave internal)
- Test: `tests/solver/integration-weapons.test.ts`
- Modify: `docs/HANDOFF.md` (log Option A follow-up + SP3b slice-1 status)

**Interfaces:**
- Consumes: `solve` (unchanged signature — `makeState` already populates `build.weapons`, so `solve` needs no logic change; verify output).
- Produces: an integration test proving weapon selection + roll + cross-slot combo + cost ceiling on real data.

- [ ] **Step 1: Confirm `solve` needs no change**

Read `src/lib/solver/solve.ts`. Confirm it returns `state.build` (which now includes resolved `weapons`) and ranks by `realized.score + statFit`. No code change expected — the weapon dimension flows through `state.build`.

- [ ] **Step 2: Write the failing integration test (real data)**

Create `tests/solver/integration-weapons.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import { loadDataset } from "@/lib/data";
import type { Build, Indexes } from "@/lib/types";

import { solve } from "@/lib/solver";
import type { SolverContext } from "@/lib/solver";

describe("solve — weapons slice (real data)", () => {
  it("selects a weapon + full roll for an open slot, feasible, re-validatable", async () => {
    const dataset = await loadDataset();
    const ctx: SolverContext = { lookup: createLookup(dataset), indexes: dataset.indexes as Indexes };

    // Pin a subclass/element + artifact so the SP3a dimensions are feasible; open one
    // weapon slot. (Fill in a real arc subclass hash, aspect hashes granting >=0 frag
    // slots, and an artifact hash from the dataset — mirror tests/solver/integration.test.ts.)
    const build = { /* … as in integration.test.ts … */
      weapons: [{ slot: "kinetic", itemHash: undefined, perkConstraints: [] }],
    } as unknown as Build;

    const result = solve(build, ctx, { beamWidth: 8, topN: 3 });
    expect(result.feasible).toBe(true);
    expect(result.builds.length).toBeGreaterThan(0);
    const top = result.builds[0].build;
    const kinetic = top.weapons.find((w) => w.slot === "kinetic");
    expect(kinetic?.itemHash).toBeDefined();               // a weapon was chosen
    // Every open column of the chosen weapon is filled (full roll):
    const weapon = ctx.lookup.weapon(kinetic!.itemHash!)!;
    const filledColumns = new Set(kinetic!.perkConstraints.map((c) => c.column));
    for (const col of weapon.perkColumns) {
      expect(filledColumns.has(col.socketIndex)).toBe(true);
    }
  });

  it("stays under the state-count ceiling on real data (loose-bound cost guard)", async () => {
    // Instrument via a wrapping bound that counts calls, OR assert wall-clock/topN
    // stability. Assert the beam completes and returns topN within a generous ceiling
    // (e.g. result.builds.length === topN and the call returns < a few seconds). This
    // is the tripwire for the deferred tightened bound.
    expect(true).toBe(true); // replace with a real counter assertion (see Step 3)
  });
});
```

Fill the `build` fixture from `tests/solver/integration.test.ts` (same pinned subclass/aspects/artifact) plus the open kinetic weapon slot.

- [ ] **Step 3: Make the cost-ceiling assertion real**

Replace the placeholder second test with a counting bound wrapper:

```ts
import { synergyUpperBound } from "@/lib/synergy";
// …
let calls = 0;
const countingBound = (b: Build, addable: Parameters<typeof synergyUpperBound>[1], l: Parameters<typeof synergyUpperBound>[2]) => {
  calls++; return synergyUpperBound(b, addable, l);
};
const result = solve(build, ctx, { beamWidth: 8, topN: 3, bound: countingBound });
expect(result.feasible).toBe(true);
// Ceiling: bounded by beamWidth × rounds × branching — assert it does not blow up.
expect(calls).toBeLessThan(50_000);
```

Tune the `50_000` ceiling to the observed count + generous headroom after first green run; document the observed number in a comment so a future regression (or the need for the tightened bound) is visible.

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `npx vitest run tests/solver/integration-weapons.test.ts`
Expected: PASS — a weapon is chosen, every column filled, feasible; call count under ceiling. If it fails to find any legal weapon, pick a slot/element with known dataset coverage (verify with a one-off `node -e` against `data/indexes.json` `slotToWeapons`).

- [ ] **Step 5: Log the Option A follow-up in HANDOFF**

In `docs/HANDOFF.md`, under the decisions/follow-ups section, add:

```markdown
- **SP3b slice-1 (weapons) shipped** the runtime plug-NAME synergy bridge (Option B):
  `Lookup.perkByName` + `collectBuildElements` name fallback. Weapon plug hashes are a
  disjoint namespace from `perks.json`, so roll synergy resolves by plug NAME to a tagged
  sandbox `Perk`. FOLLOW-UP (Option A, deferred): tag weapon plugs at ingest in
  `scripts/ingest/transform.ts` (mirror the aspect/fragment `tags: tag({ text: itemText(...) })`
  call, add `tags` to `WeaponPerk`), to be folded into the NEXT legitimate re-ingest — NOT
  triggered standalone (full manifest re-fetch = unrelated season churn + OOM risk). Once
  landed, plugs carry hash tags and the name bridge degrades to a harmless fallback.
```

- [ ] **Step 6: Full green gate + commit**

```bash
npx tsc --noEmit && npx eslint scripts src tests && npx vitest run
git add src/lib/solver/index.ts tests/solver/integration-weapons.test.ts docs/HANDOFF.md
git commit -m "test(solver): weapons slice real-data integration + cost ceiling; log Option A follow-up"
```

---

## Self-review notes (author)

- **Spec coverage:** name bridge (T1), membership pre-filter (T2), reach-union bound + open-slot feasibility (T3), staged weapon/plug candidates + one-plug-per-column + pinned-column respect (T2 openColumns + T4), joint beam / cross-slot (T5 + T6), ammo eager-prune (T5), terminal roll output (T5/T6), curated-resolution + cost-ceiling tests (T1/T6), Option A deferral logged (T6). All spec sections map to a task.
- **Additive-compat:** `makeState`/`stateKey`/`generateCandidates` gain trailing params (default `[]`), and `stateKey` appends the weapon segment only when picks exist — so SP3a's audited beam behavior and key assertions stay byte-identical. Any SP3a test that calls `generateCandidates` directly must add the empty weapon env fields + `[]` picks (called out in T4 Step 6).
- **Type consistency:** `WeaponPick` defined once in `candidates.ts`, imported by `beam.ts` (no cycle: `beam` already imports from `candidates`). `Candidate.slot`/`column` optional, set only for weapon/weaponPerk. `resolvePlugTags` on the env keeps `generateCandidates` lookup-free and synchronous.
- **Known v1 limitations (documented in code):** greedy (not exact-matching) pin-to-column assignment may over-exclude a weapon a full bipartite matching would admit; ammo eager-prune fires only when both non-power slots are decided (a slot-pool-aware tighter prune is deferred); loose open-slot bound may widen the beam (cost-ceiling test is the tripwire).
