# SP3b slice 2b — Solver-chosen exotic armor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the beam choose `armor.exoticHash` — one exotic armor piece from the build's Guardian-class pool, honouring a `useExotic` pin.

**Architecture:** One new open dimension on the existing SP3a/slice-1 beam, following the weapons slice's shape but simpler (no sub-slot staging — an exotic's slot is fixed by the item). A new `src/lib/solver/armor.ts` derives the pool and its bound-reach; `candidates.ts`, `beam.ts`, `types/build.ts` and `validation/armor.ts` gain additive changes. `collectBuildElements` already reads `armor.exoticHash`, so there is no synergy-side plumbing.

**Tech Stack:** TypeScript (strict), Vitest, `@/*` → `src/` alias. No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-phase2-sp3b-slice2b-exotic-armor-solver-design.md`.
- Baseline to preserve: **176/176 tests (34 files)**, `npx tsc --noEmit` clean, `npx eslint scripts src tests` clean.
- **Every change is additive with trailing default parameters.** SP3a and slice-1 state keys, results, and costs must stay byte-identical.
- **`classType` is `Exclude<GuardianClass, "any">`, never bare `GuardianClass`.** `"any"` is meaningless for a subclass and would yield an empty pool plus a silent `feasible: false`.
- Pool dedup prefers the **richest tag set**, tie-broken by **lowest hash**. Never blind lowest-hash.
- Untagged exotics **stay in the pool** — exactly one exotic is a game floor, and they matter once SP4 fills `StatFit`.
- The existing weapons cost tripwire must still measure **exactly 10,842** bound calls. That number is the proof this slice is additive rather than merely non-breaking.
- No `data/` regeneration. No network. This slice is pure code.
- Run the full trio before every commit: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/solver/armor.ts` (**create**) | `deriveExoticArmorPool` + `deriveExoticReach`. Pool membership and bound-reach only — no beam state. |
| `src/lib/solver/candidates.ts` (modify) | Adds the `exoticArmor` candidate kind. |
| `src/lib/solver/beam.ts` (modify) | Env/state wiring, `stateKey`, terminal guard. |
| `src/lib/types/build.ts` (modify) | `SubclassLoadout.classType`. |
| `src/lib/validation/armor.ts` (modify) | Completes the deferred `classConsistency` class-match clause. |
| `tests/solver/armor-pool.test.ts` (create) | Pool derivation + reach units, incl. real-data dedup contract. |
| `tests/solver/candidates-exotic.test.ts` (create) | Candidate emission units. |
| `tests/solver/beam-exotic-wiring.test.ts` (create) | `stateKey`, env resolution, terminal behaviour. |
| `tests/solver/beam-exotic.test.ts` (create) | The acceptance gate. |
| `tests/solver/integration-exotic.test.ts` (create) | Real-data integration + the new cost tripwire. |
| `tests/validation/armor.test.ts` (modify) | The new class-match clause. |

**Task order note (from spec review finding 2):** Task 5 measures real-data bound-call cost **immediately** after the beam wiring in Task 4. Do not defer it. `exoticReach` contributes ~38 tagged elements to `addable` where a real build contributes one exotic (~38× over-credit), and slice 2a showed inflated producer counts can blow the bound up 6×. If Task 5's measurement is unacceptable, the pre-decided response is to require a `useExotic` pin — do not redesign the dimension.

---

### Task 1: `SubclassLoadout.classType` + the validator's class-match clause

**Files:**
- Modify: `src/lib/types/build.ts:15-20` (`SubclassLoadout`)
- Modify: `src/lib/validation/armor.ts:35-59` (`classConsistency`)
- Test: `tests/validation/armor.test.ts`

**Interfaces:**
- Produces: `SubclassLoadout.classType?: Exclude<GuardianClass, "any">` — read by `buildSolverEnv` in Task 4 and by `classConsistency` here.

- [ ] **Step 1: Write the failing tests**

`tests/validation/armor.test.ts` already has a `run(build, lookup)` helper that flat-maps every
rule in `armorRules` to violation codes, and a `base` Build literal. Reuse both — for these
fixtures the other three armor rules stay silent (`exoticCount` returns early on zero specified
pieces, and `slotUniqueness`/`setBonusCounts` have nothing to inspect), so `run` reports only
this rule's codes. **No new export is needed.**

The file currently imports `it` but not `describe`, so widen the vitest import on line 1:

```ts
import { describe, expect, it } from "vitest";
```

Then append:

```ts
describe("classConsistency — build class match (slice 2b)", () => {
  // A(hash, slot, tier, classType) is the existing helper defined above in this file.
  const lookup = {
    armor: (h: number) =>
      h === 900 ? A(900, "helmet", "exotic", "warlock")
        : h === 901 ? A(901, "arms", "exotic", "titan")
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

  it("still catches pieces spanning multiple classes with no class pinned", () => {
    expect(run(
      withClass(undefined, {
        pieces: [{ slot: "helmet", itemHash: 900 }, { slot: "arms", itemHash: 901 }],
      }),
      lookup,
    )).toEqual(["ARMOR_CLASS_MISMATCH"]);
  });
});
```

If the existing `A` helper's signature differs from `A(hash, slot, tier, classType)`, read it at the
top of the file and adapt these four calls — do not change `A` itself.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/validation/armor.test.ts`
Expected: FAIL — the first test gets `[]` because the class-match clause does not exist yet, and
`subclass.classType` is not yet a valid property.

- [ ] **Step 3: Add `classType` to the build model**

In `src/lib/types/build.ts`, replace the `SubclassLoadout` interface (lines 15-20) with:

```ts
/** Subclass configuration within a build. */
export interface SubclassLoadout {
  element?: SubclassElement;
  /**
   * The build's Guardian class. Optional, and that is load-bearing: absent means the
   * solver's exotic-armor dimension stays CLOSED, so every build predating slice 2b
   * behaves byte-identically. `Exclude<..., "any">` because a subclass belongs to exactly
   * one class — bare `GuardianClass` would admit `"any"`, which matches no exotic and
   * would surface as a silent `feasible: false`.
   */
  classType?: Exclude<GuardianClass, "any">;
  superHash?: Hash;
  aspectHashes: Hash[];
  fragmentHashes: Hash[];
}
```

`GuardianClass` must be in that file's type import from `./common`. Add it to the existing import block if absent.

- [ ] **Step 4: Complete the `classConsistency` clause**

In `src/lib/validation/armor.ts`, replace the whole `classConsistency` const (lines 35-59) with:

```ts
/**
 * Flags armor spanning multiple Guardian classes, and (slice 2b) armor whose class
 * contradicts the build's pinned `subclass.classType`.
 *
 * The second clause was deferred in Phase 1 purely because the build model carried no
 * class; slice 2b adds `SubclassLoadout.classType`, so it is enabled here. It fires ONLY
 * when a class is pinned — otherwise every build predating slice 2b would gain a violation.
 *
 * `armor.exoticHash` is checked alongside `pieces` because the solver records its chosen
 * exotic there and never writes `pieces` (that is SP4's job).
 */
const classConsistency: Rule = (build, lookup) => {
  const classOf = (hash: Hash | undefined) =>
    hash === undefined ? undefined : lookup.armor(hash)?.classType;

  const observed = new Set(
    [
      ...specifiedPieces(build).map((p) => classOf(p.itemHash)),
      classOf(build.armor.exoticHash),
    ].filter((c): c is Exclude<GuardianClass, "any"> => Boolean(c) && c !== "any"),
  );

  const out: Violation[] = [];
  if (observed.size > 1) {
    out.push({
      code: "ARMOR_CLASS_MISMATCH",
      category: "game",
      message: `Armor pieces span multiple classes: ${[...observed].join(", ")}.`,
      subject: { kind: "armor" },
    });
  }

  const pinned = build.subclass.classType;
  if (pinned !== undefined) {
    const wrong = [...observed].filter((c) => c !== pinned);
    if (wrong.length > 0) {
      out.push({
        code: "ARMOR_CLASS_MISMATCH",
        category: "game",
        message: `Armor class ${wrong.join(", ")} does not match the build's ${pinned} subclass.`,
        subject: { kind: "armor" },
      });
    }
  }
  return out;
};
```

`Hash` must be in that file's type import from `@/lib/types`; add it if absent. The name
`classConsistency` is unchanged, so the existing `armorRules` array (line 118) needs no edit.

Note: a build with mixed-class pieces AND a pinned class yields **two** violations. That is intentional — they are two distinct facts.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/validation/armor.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full trio**

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`
Expected: all green, 176 + 4 = 180 tests.

If any pre-existing test now fails, it is because that test set `armor.exoticHash` to a piece whose class contradicts other pieces — a genuine bug this clause newly catches. Verify by hand before changing the test; do not re-baseline reflexively.

- [ ] **Step 7: Commit**

```bash
git add src/lib/types/build.ts src/lib/validation/armor.ts tests/validation/armor.test.ts
git commit -m "feat(types): add SubclassLoadout.classType and complete the armor class-match rule

Phase 1 deferred classConsistency's second clause because the build model carried
no Guardian class. Slice 2b needs one to filter the exotic armor pool, so it lands
here and the clause is completed. Typed Exclude<GuardianClass, \"any\"> because a
subclass belongs to exactly one class; bare GuardianClass would admit \"any\", which
matches no exotic and would surface as a silent feasible:false. The clause fires
only when a class is pinned, so every pre-slice-2b build is unaffected, and it
checks armor.exoticHash alongside pieces since that is where the solver records
its choice."
```

---

### Task 2: `deriveExoticArmorPool` + `deriveExoticReach`

**Files:**
- Create: `src/lib/solver/armor.ts`
- Test: `tests/solver/armor-pool.test.ts`

**Interfaces:**
- Consumes: `SolverContext` from `./types`; `ctx.indexes.exoticToClassSlot`; `ctx.lookup.armor`.
- Produces:
  - `deriveExoticArmorPool(ctx: SolverContext, classType?: Exclude<GuardianClass, "any">, pinnedHash?: Hash): Armor[]`
  - `deriveExoticReach(pool: Armor[]): BuildElement[]`

- [ ] **Step 1: Write the failing tests**

Create `tests/solver/armor-pool.test.ts`:

```ts
import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import { loadDataset } from "@/lib/data";
import type { Armor, DerivedDataset } from "@/lib/types";

import { deriveExoticArmorPool, deriveExoticReach } from "@/lib/solver/armor";
import type { SolverContext } from "@/lib/solver";

const EMPTY_INDEXES = {
  keyword: { producers: {}, consumers: {} },
  perkToWeapons: {}, elementToItems: {}, setToPieces: {},
  exoticToClassSlot: {}, slotToWeapons: {},
};

const armor = (over: Partial<Armor> & { hash: number; name: string }): Armor => ({
  kind: "armor", icon: "", slot: "helmet", tier: "exotic", classType: "warlock",
  modSocketHashes: [], tags: { produces: [], consumes: [], triggers: [] }, ...over,
}) as Armor;

function ctxWith(pieces: Armor[]): SolverContext {
  const exoticToClassSlot: Record<number, { classType: string; slot: string }> = {};
  for (const a of pieces) exoticToClassSlot[a.hash] = { classType: a.classType, slot: a.slot };
  const ds = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [], fragments: [], weapons: [], armor: pieces,
    armorSets: [], mods: [], artifacts: [], perks: [], stats: [], plugTags: {},
    indexes: { ...EMPTY_INDEXES, exoticToClassSlot },
  } as unknown as DerivedDataset;
  return { lookup: createLookup(ds), indexes: ds.indexes };
}

describe("deriveExoticArmorPool", () => {
  it("filters to the requested class", () => {
    const ctx = ctxWith([
      armor({ hash: 10, name: "W", classType: "warlock" }),
      armor({ hash: 11, name: "T", classType: "titan" }),
    ]);
    expect(deriveExoticArmorPool(ctx, "warlock").map((a) => a.hash)).toEqual([10]);
  });

  it("dedups duplicate names, preferring the RICHEST tag set over the lowest hash", () => {
    // Hash 20 is lower but untagged; 21 carries a tag. Blind lowest-hash would lose the tag.
    const ctx = ctxWith([
      armor({ hash: 20, name: "Dupe" }),
      armor({ hash: 21, name: "Dupe", tags: { produces: ["jolt"], consumes: [], triggers: [] } }),
    ]);
    const pool = deriveExoticArmorPool(ctx, "warlock");
    expect(pool).toHaveLength(1);
    expect(pool[0].hash).toBe(21);
  });

  it("tie-breaks equal-richness duplicates on the lowest hash, for determinism", () => {
    const ctx = ctxWith([
      armor({ hash: 31, name: "Dupe" }),
      armor({ hash: 30, name: "Dupe" }),
    ]);
    expect(deriveExoticArmorPool(ctx, "warlock").map((a) => a.hash)).toEqual([30]);
  });

  it("returns a hash-sorted pool", () => {
    const ctx = ctxWith([
      armor({ hash: 42, name: "B" }), armor({ hash: 41, name: "A" }), armor({ hash: 43, name: "C" }),
    ]);
    expect(deriveExoticArmorPool(ctx, "warlock").map((a) => a.hash)).toEqual([41, 42, 43]);
  });

  it("narrows to a single entry when pinned", () => {
    const ctx = ctxWith([armor({ hash: 50, name: "A" }), armor({ hash: 51, name: "B" })]);
    expect(deriveExoticArmorPool(ctx, "warlock", 51).map((a) => a.hash)).toEqual([51]);
  });

  it("returns EMPTY when the pin contradicts the class", () => {
    const ctx = ctxWith([
      armor({ hash: 60, name: "W", classType: "warlock" }),
      armor({ hash: 61, name: "T", classType: "titan" }),
    ]);
    expect(deriveExoticArmorPool(ctx, "warlock", 61)).toEqual([]);
  });

  it("returns EMPTY for a pin naming an unknown hash", () => {
    const ctx = ctxWith([armor({ hash: 70, name: "A" })]);
    expect(deriveExoticArmorPool(ctx, "warlock", 99999)).toEqual([]);
  });

  it("returns EMPTY with neither a class nor a pin (the dimension is closed)", () => {
    const ctx = ctxWith([armor({ hash: 80, name: "A" })]);
    expect(deriveExoticArmorPool(ctx)).toEqual([]);
  });

  it("uses the pin alone when no class is available to check it against", () => {
    const ctx = ctxWith([armor({ hash: 90, name: "A" }), armor({ hash: 91, name: "B" })]);
    expect(deriveExoticArmorPool(ctx, undefined, 91).map((a) => a.hash)).toEqual([91]);
  });
});

describe("deriveExoticReach", () => {
  it("maps tagged pool entries to BuildElements with an armor: source", () => {
    const pool = [
      armor({ hash: 100, name: "Tagged", tags: { produces: ["jolt"], consumes: [], triggers: [] } }),
    ];
    expect(deriveExoticReach(pool)).toEqual([
      { hash: 100, source: "armor:Tagged", tags: { produces: ["jolt"], consumes: [], triggers: [] } },
    ]);
  });

  it("omits untagged entries — they cannot move the bound", () => {
    expect(deriveExoticReach([armor({ hash: 101, name: "Inert" })])).toEqual([]);
  });
});

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));

describe.runIf(hasDataset)("deriveExoticArmorPool — real data", () => {
  it("dedups 116 entries to 47 distinct names per class", async () => {
    const ds = await loadDataset();
    const ctx: SolverContext = { lookup: createLookup(ds), indexes: ds.indexes };
    for (const cls of ["warlock", "titan", "hunter"] as const) {
      const pool = deriveExoticArmorPool(ctx, cls);
      expect(pool.length, cls).toBe(47);
      expect(new Set(pool.map((a) => a.name)).size, cls).toBe(47);
      expect(pool.every((a) => a.tier === "exotic" && a.classType === cls), cls).toBe(true);
    }
  });

  // Contract: this is what turns a future divergence into a loud failure instead of
  // quietly dropped synergy. 0 of 141 same-name groups disagree today.
  it("same-name exotics agree on their tags", async () => {
    const ds = await loadDataset();
    const sig = (a: Armor) => JSON.stringify([
      [...a.tags.produces].sort(), [...a.tags.consumes].sort(), [...a.tags.triggers].sort(),
    ]);
    const groups = new Map<string, Set<string>>();
    for (const a of ds.armor.filter((x) => x.tier === "exotic")) {
      const key = `${a.classType}|${a.name}`;
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key)!.add(sig(a));
    }
    const diverging = [...groups.entries()].filter(([, sigs]) => sigs.size > 1).map(([k]) => k);
    expect(diverging).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/solver/armor-pool.test.ts`
Expected: FAIL — cannot resolve `@/lib/solver/armor`.

- [ ] **Step 3: Create the module**

Create `src/lib/solver/armor.ts`:

```ts
import type { Armor, GuardianClass, Hash } from "@/lib/types";

import type { BuildElement } from "@/lib/synergy";

import type { SolverContext } from "./types";

/** Tag richness, for preferring the best-tagged duplicate of a name. */
const tagSize = (a: Armor) =>
  a.tags.produces.length + a.tags.consumes.length + a.tags.triggers.length;

/**
 * Exotic armor legal for this class, deduped by name, hash-sorted.
 *
 * Measured on the slice-2a dataset: the manifest carries 116 exotic entries but only 47
 * distinct names per class (348 entries / 141 names overall — a 2.47x duplication factor),
 * so deduping is not cosmetic: without it the beam wastes ~2.5x its branching re-exploring
 * identical items.
 *
 * Dedup prefers the entry with the RICHEST tag set, tie-broken by lowest hash — the same
 * "prefer tagged" rule `createLookup` uses for `perkByName`. All 141 groups currently agree
 * on their tags, so blind lowest-hash would lose nothing *today*, but nothing enforces that
 * and a future re-ingest carrying a divergent duplicate would silently drop synergy.
 *
 * Untagged exotics are kept: exactly one exotic is a game floor, and they become meaningful
 * once SP4 fills the `StatFit` seam. Do not "optimize" them out.
 *
 * Returns `[]` when given neither a class nor a pin — the caller treats a non-empty pool as
 * exactly equivalent to "the exotic dimension is open".
 */
export function deriveExoticArmorPool(
  ctx: SolverContext,
  classType?: Exclude<GuardianClass, "any">,
  pinnedHash?: Hash,
): Armor[] {
  if (classType === undefined && pinnedHash === undefined) return [];

  const byName = new Map<string, Armor>();
  for (const [key, meta] of Object.entries(ctx.indexes.exoticToClassSlot)) {
    if (classType !== undefined && meta.classType !== classType) continue;
    const hash = Number(key);
    if (pinnedHash !== undefined && hash !== pinnedHash) continue;
    const piece = ctx.lookup.armor(hash);
    if (!piece || piece.tier !== "exotic") continue;
    const existing = byName.get(piece.name);
    const better =
      !existing ||
      tagSize(piece) > tagSize(existing) ||
      (tagSize(piece) === tagSize(existing) && piece.hash < existing.hash);
    if (better) byName.set(piece.name, piece);
  }
  return [...byName.values()].sort((a, b) => a.hash - b.hash);
}

/**
 * Loose reachable-union for an undecided exotic slot: every tagged pool entry as a
 * `BuildElement`. A superset of what any single completion contributes (a build takes exactly
 * ONE exotic), so it over-credits only — safe for an admissible bound. Untagged entries are
 * omitted because they cannot move the bound. Keyed by armor hash, which IS the synergy
 * identity for armor — no name-bridging arises here, unlike weapon plugs.
 */
export function deriveExoticReach(pool: Armor[]): BuildElement[] {
  return pool
    .filter((a) => tagSize(a) > 0)
    .map((a) => ({ hash: a.hash, source: `armor:${a.name}`, tags: a.tags }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/solver/armor-pool.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Run the full trio and commit**

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`

```bash
git add src/lib/solver/armor.ts tests/solver/armor-pool.test.ts
git commit -m "feat(solver): derive the exotic armor pool and its bound reach

deriveExoticArmorPool filters indexes.exoticToClassSlot by Guardian class, dedups
by name preferring the richest tag set (tie-break lowest hash), and hash-sorts.
The dedup is load-bearing: the manifest carries 116 exotic entries but 47 distinct
names per class, so without it the beam wastes ~2.5x its branching on identical
items. A real-data contract test asserts same-name exotics agree on tags, so a
future divergent duplicate fails loudly instead of silently dropping synergy.

deriveExoticReach maps tagged entries to BuildElements for the open-slot bound —
a superset of the one exotic a build takes, so it over-credits only."
```

---

### Task 3: The `exoticArmor` candidate kind

**Files:**
- Modify: `src/lib/solver/candidates.ts:43-55` (`Candidate`), `:65-75` (`CandidateEnv`), `:83-89` (signature), and the body
- Test: `tests/solver/candidates-exotic.test.ts`

**Interfaces:**
- Consumes: `Armor` from `@/lib/types`.
- Produces:
  - `Candidate.kind` gains `"exoticArmor"`.
  - `CandidateEnv.exoticPool: Armor[]`.
  - `generateCandidates(env, fragHashes, perkHashes, cap, weaponPicks, exoticHash?)` — the new trailing param. Task 4 passes it.

- [ ] **Step 1: Write the failing tests**

Create `tests/solver/candidates-exotic.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { Armor } from "@/lib/types";

import { generateCandidates } from "@/lib/solver/candidates";

const armor = (hash: number, name: string, produces: string[] = []): Armor => ({
  kind: "armor", hash, name, icon: "", slot: "helmet", tier: "exotic",
  classType: "warlock", modSocketHashes: [],
  tags: { produces, consumes: [], triggers: [] },
}) as Armor;

/** Minimal env: every other dimension inert, so only exotic moves can appear. */
const envWith = (exoticPool: Armor[]) => ({
  fragmentPool: [], perkPool: [], fragmentCap: 0,
  capModel: { nativeTier: new Map(), tiers: [] } as never,
  openWeaponSlots: [], weaponPool: new Map(),
  resolvePlugTags: () => ({ produces: [], consumes: [], triggers: [] }),
  exoticPool,
});

const CAP = { feasible: true, selected: 0, capacity: 0, headroomByTier: [] } as never;

describe("generateCandidates — exotic armor", () => {
  it("offers one move per pool entry while the exotic is undecided", () => {
    const pool = [armor(10, "A", ["jolt"]), armor(11, "B")];
    const out = generateCandidates(envWith(pool), [], [], CAP, [], undefined);
    expect(out.map((c) => [c.kind, c.hash])).toEqual([
      ["exoticArmor", 10], ["exoticArmor", 11],
    ]);
  });

  it("carries the armor's tags and an armor: source on the element", () => {
    const out = generateCandidates(envWith([armor(10, "A", ["jolt"])]), [], [], CAP, [], undefined);
    expect(out[0].element).toEqual({
      hash: 10, source: "armor:A", tags: { produces: ["jolt"], consumes: [], triggers: [] },
    });
  });

  it("offers nothing once the exotic is decided", () => {
    const pool = [armor(10, "A"), armor(11, "B")];
    expect(generateCandidates(envWith(pool), [], [], CAP, [], 10)).toEqual([]);
  });

  it("offers nothing when the pool is empty (dimension closed)", () => {
    expect(generateCandidates(envWith([]), [], [], CAP, [], undefined)).toEqual([]);
  });

  it("omits the trailing arg entirely — byte-compatible with slice 1 call sites", () => {
    expect(generateCandidates(envWith([]), [], [], CAP, [])).toEqual([]);
  });
});
```

Note the last test — and note what it does NOT claim. With `exoticHash` omitted it is
`undefined`, so a **non-empty** pool WOULD offer moves; omitting the arg is not by itself a
way to keep the dimension closed. The env's pool is what closes it. So this test pairs an
old-style 5-arg call with an **empty** pool, pinning the only property slice 1 needs: an
existing call site that never learned about exotics still produces no exotic moves, because
its env carries no pool. Implement `CandidateEnv.exoticPool` as required-but-possibly-empty;
Task 4 always supplies it.

(Corrected during pre-flight review, 2026-07-28: this test previously passed
`envWith([armor(10, "A")])` while asserting `[]`, which contradicts this task's own
implementation — an omitted trailing arg plus a one-entry pool emits one candidate. Ruling:
the stated intent governs, so the fixture is now an empty pool.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/solver/candidates-exotic.test.ts`
Expected: FAIL — `exoticPool` is not a known property, and no `exoticArmor` candidates are produced.

- [ ] **Step 3: Extend the candidate type and env**

In `src/lib/solver/candidates.ts`:

Add `Armor` to the type import on line 1:

```ts
import type { Armor, Artifact, ArtifactPerk, Fragment, Hash, KeywordTags, SubclassElement, WeaponSlot } from "@/lib/types";
```

Change `Candidate.kind` (line 45) to:

```ts
  kind: "fragment" | "artifactPerk" | "weapon" | "weaponPerk" | "exoticArmor";
```

Add to `CandidateEnv` (after `weaponPool`, line 72):

```ts
  /** Class-filtered, name-deduped exotic pool. EMPTY ⇒ the exotic dimension is closed. */
  exoticPool: Armor[];
```

- [ ] **Step 4: Emit the candidates**

Change the `generateCandidates` signature (lines 83-89) to add the trailing param:

```ts
export function generateCandidates(
  env: CandidateEnv,
  fragHashes: Hash[],
  perkHashes: Hash[],
  cap: Capacity,
  weaponPicks: WeaponPick[],
  exoticHash?: Hash,
): Candidate[] {
```

Then insert this block immediately after the artifact-perk `for` loop and before `const pickBySlot = ...`:

```ts
  // Exotic armor: a single-select dimension. Unlike weapons there is no second stage —
  // an exotic's slot is fixed by the item, so choosing the item decides the slot.
  if (exoticHash === undefined) {
    for (const a of env.exoticPool) {
      out.push({ kind: "exoticArmor", hash: a.hash,
        element: { hash: a.hash, source: `armor:${a.name}`, tags: a.tags } });
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/solver/candidates-exotic.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the full trio and commit**

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`

`tests/solver/candidates-weapons.test.ts` and `candidates.test.ts` build `weaponEnv`/env objects literally, so they will need `exoticPool: []` added to satisfy the type. That is a mechanical fixture update, not a behaviour change — make it and say so in the commit.

```bash
git add src/lib/solver/candidates.ts tests/solver/candidates-exotic.test.ts tests/solver/candidates-weapons.test.ts tests/solver/candidates.test.ts
git commit -m "feat(solver): add the exoticArmor candidate kind

A single-select dimension: one move picks one exotic. Simpler than the weapons
dimension, which needed a second stage to fill perk columns — an exotic's slot is
fixed by the item. Offered only while undecided and only when the pool is
non-empty, with the armor's own hash as element identity (armor hashes ARE the
synergy identity; no name-bridging arises as it does for weapon plugs).

exoticHash is a trailing optional param so existing call sites are unchanged.
Existing candidate-test envs gain exoticPool: [] to satisfy the type."
```

---

### Task 4: Beam wiring

**Files:**
- Modify: `src/lib/solver/beam.ts` — imports, `SolverEnv` (`:30-51`), `SolverState` (`:54-65`), `stateKey` (`:68-77`), `buildSolverEnv` (`:84-138`), `makeState` (`:141-185`), `expand` (`:188-209`), `beamSearch` terminal guard (`:255-271`)
- Test: `tests/solver/beam-exotic-wiring.test.ts` (create)

**Interfaces:**
- Consumes: `deriveExoticArmorPool`, `deriveExoticReach` (Task 2); `generateCandidates`'s trailing `exoticHash` (Task 3); `SubclassLoadout.classType` (Task 1).
- Produces: `SolverEnv.exoticPool: Armor[]`, `SolverEnv.exoticReach: BuildElement[]`, `SolverState.exoticHash?: Hash`, and `stateKey(frag, perk, weaponPicks?, exoticHash?)`.

- [ ] **Step 1: Write the failing tests**

Create `tests/solver/beam-exotic-wiring.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import { synergyUpperBound } from "@/lib/synergy";
import type { Armor, Artifact, Aspect, Build, DerivedDataset } from "@/lib/types";
import { EMPTY_TAGS } from "@/lib/types";

import { beamSearch, buildSolverEnv, stateKey } from "@/lib/solver/beam";
import type { SolverContext } from "@/lib/solver";

const EMPTY_INDEXES = {
  keyword: { producers: {}, consumers: {} },
  perkToWeapons: {}, elementToItems: {}, setToPieces: {},
  exoticToClassSlot: {}, slotToWeapons: {},
};

const aspect100: Aspect = {
  kind: "aspect", hash: 100, name: "Asp", element: "arc", classType: "any",
  fragmentSlots: 0, tags: EMPTY_TAGS,
};
const artifact300: Artifact = {
  kind: "artifact", hash: 300, name: "Art", tiers: [{ tierIndex: 0, slots: 0, perks: [] }],
};

const exo = (hash: number, name: string, classType = "warlock"): Armor => ({
  kind: "armor", hash, name, icon: "", slot: "helmet", tier: "exotic",
  classType, modSocketHashes: [], tags: EMPTY_TAGS,
}) as Armor;

function ctxWith(pieces: Armor[]): SolverContext {
  const exoticToClassSlot: Record<number, { classType: string; slot: string }> = {};
  for (const a of pieces) exoticToClassSlot[a.hash] = { classType: a.classType, slot: a.slot };
  const ds = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [aspect100], fragments: [], weapons: [], armor: pieces,
    armorSets: [], mods: [], artifacts: [artifact300], perks: [], stats: [], plugTags: {},
    indexes: { ...EMPTY_INDEXES, exoticToClassSlot },
  } as unknown as DerivedDataset;
  return { lookup: createLookup(ds), indexes: ds.indexes };
}

const build = (over: { classType?: string; exoticHash?: number; constraints?: unknown[] } = {}): Build => ({
  subclass: { element: "arc", aspectHashes: [100], fragmentHashes: [], classType: over.classType },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [], exoticHash: over.exoticHash },
  artifact: { artifactHash: 300, selectedPerkHashes: [] },
  constraints: over.constraints ?? [],
}) as unknown as Build;

describe("stateKey — exotic component", () => {
  it("is byte-identical to slice 1 when no exotic is given", () => {
    expect(stateKey([1, 2], [3])).toBe("frag:1,2|perk:3");
    expect(stateKey([1, 2], [3], [])).toBe("frag:1,2|perk:3");
  });

  it("appends the exotic when present", () => {
    expect(stateKey([1], [2], [], 55)).toBe("frag:1|perk:2|exo:55");
  });
});

describe("buildSolverEnv — exotic dimension", () => {
  it("leaves the dimension CLOSED with no classType and no pin", () => {
    const env = buildSolverEnv(build(), ctxWith([exo(10, "A")]), {})!;
    expect(env.exoticPool).toEqual([]);
  });

  it("opens the dimension when classType is pinned", () => {
    const env = buildSolverEnv(build({ classType: "warlock" }), ctxWith([exo(10, "A"), exo(11, "B")]), {})!;
    expect(env.exoticPool.map((a) => a.hash)).toEqual([10, 11]);
  });

  it("narrows to the pinned exotic via a useExotic constraint", () => {
    const ctx = ctxWith([exo(10, "A"), exo(11, "B")]);
    const env = buildSolverEnv(
      build({ classType: "warlock", constraints: [{ kind: "useExotic", itemHash: 11 }] }), ctx, {},
    )!;
    expect(env.exoticPool.map((a) => a.hash)).toEqual([11]);
  });

  it("is INFEASIBLE when the pin contradicts the pinned class", () => {
    const ctx = ctxWith([exo(10, "A", "warlock"), exo(11, "B", "titan")]);
    const env = buildSolverEnv(
      build({ classType: "warlock", constraints: [{ kind: "useExotic", itemHash: 11 }] }), ctx, {},
    );
    expect(env).toBeNull();
  });

  it("keeps the dimension closed when the base already fixes exoticHash", () => {
    const env = buildSolverEnv(
      build({ classType: "warlock", exoticHash: 10 }), ctxWith([exo(10, "A")]), {},
    )!;
    expect(env.exoticPool).toEqual([]);
  });
});

describe("beamSearch — exotic terminal behaviour", () => {
  it("chooses an exotic and records it on the completed build", () => {
    const ctx = ctxWith([exo(10, "A"), exo(11, "B")]);
    const env = buildSolverEnv(build({ classType: "warlock" }), ctx, {})!;
    const completed = beamSearch(env, synergyUpperBound);
    expect(completed.length).toBeGreaterThan(0);
    for (const s of completed) {
      expect(s.exoticHash).toBeDefined();
      expect(s.build.armor.exoticHash).toBe(s.exoticHash);
    }
  });

  it("returns no completion when the dimension is open but every state is a dead end", () => {
    // Pool of one whose only member is filtered out by tier — pool empty ⇒ infeasible env.
    const notExotic = { ...exo(10, "A"), tier: "legendary" } as Armor;
    const env = buildSolverEnv(build({ classType: "warlock" }), ctxWith([notExotic]), {});
    expect(env).toBeNull();
  });

  it("preserves the base exoticHash through unrelated moves", () => {
    const env = buildSolverEnv(
      build({ classType: "warlock", exoticHash: 10 }), ctxWith([exo(10, "A")]), {},
    )!;
    const completed = beamSearch(env, synergyUpperBound);
    for (const s of completed) expect(s.build.armor.exoticHash).toBe(10);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/solver/beam-exotic-wiring.test.ts`
Expected: FAIL — `stateKey` takes 3 params, `env.exoticPool` is undefined.

- [ ] **Step 3: Extend the env and state types**

In `src/lib/solver/beam.ts`, add to the type import on line 1: `Armor` and `Constraint`:

```ts
import type { Armor, ArtifactPerk, Build, Constraint, Fragment, Hash, KeywordTags, PerkConstraint, SubclassElement, WeaponSlot } from "@/lib/types";
```

Add the armor import after the `./candidates` import block (line 16):

```ts
import { deriveExoticArmorPool, deriveExoticReach } from "./armor";
```

Add to `SolverEnv`, after `resolvePlugTags` (line 50):

```ts
  /**
   * Class-filtered, name-deduped exotic pool. A NON-EMPTY pool is exactly equivalent to
   * "the exotic dimension is open" — `buildSolverEnv` returns null when the dimension is
   * open but admits nothing, so no separate flag is needed.
   */
  exoticPool: Armor[];
  /** Precomputed loose reachable-union for the undecided exotic (open-slot bound). */
  exoticReach: BuildElement[];
```

Add to `SolverState`, after `weapons` (line 64):

```ts
  /** The chosen exotic, when this dimension is open and decided. */
  exoticHash?: Hash;
```

- [ ] **Step 4: Extend `stateKey`**

Replace `stateKey` (lines 67-77) with:

```ts
/** Order-independent identity for a partial build (dedup + stable tie-break). */
export function stateKey(
  fragHashes: Hash[],
  perkHashes: Hash[],
  weaponPicks: WeaponPick[] = [],
  exoticHash?: Hash,
): string {
  const s = (xs: Hash[]) => [...xs].sort((a, b) => a - b).join(",");
  let key = `frag:${s(fragHashes)}|perk:${s(perkHashes)}`;
  if (weaponPicks.length > 0) {
    const wpn = [...weaponPicks]
      .sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0))
      .map((p) => `${p.slot}=${p.itemHash}[${s(p.plugHashes)}]`)
      .join(";");
    key = `${key}|wpn:${wpn}`;
  }
  // Both components are appended only when present, so SP3a and slice-1 keys are
  // byte-identical (no exotic ⇒ no suffix).
  if (exoticHash !== undefined) key = `${key}|exo:${exoticHash}`;
  return key;
}
```

- [ ] **Step 5: Resolve the pool in `buildSolverEnv`**

Insert immediately after the weapon-pool `for` loop (after line 116) and before `const resolvePlugTags`:

```ts
  // Exotic armor. The dimension is OPEN iff the base does not already fix an exotic AND we
  // have either a Guardian class to filter by or a useExotic pin. Because we return null
  // when it is open but admits nothing, a non-empty pool ⇔ open.
  let pinnedExotic: Hash | undefined;
  for (const c of base.constraints as Constraint[]) {
    if (c.kind === "useExotic") pinnedExotic = c.itemHash;
  }
  const classType = base.subclass.classType;
  let exoticPool: Armor[] = [];
  if (base.armor.exoticHash === undefined && (classType !== undefined || pinnedExotic !== undefined)) {
    exoticPool = deriveExoticArmorPool(ctx, classType, pinnedExotic);
    // Pin contradicts the class, or names a hash absent from the dataset. Slice 4 will
    // explain WHICH; here it is simply infeasible.
    if (exoticPool.length === 0) return null;
  }
```

Then add to the returned object, after `resolvePlugTags` (line 136):

```ts
    exoticPool,
    exoticReach: deriveExoticReach(exoticPool),
```

- [ ] **Step 6: Thread the exotic through `makeState`**

Change the signature (lines 141-147) to add the trailing param:

```ts
export function makeState(
  env: SolverEnv,
  fragHashes: Hash[],
  perkHashes: Hash[],
  bound: BoundFn,
  weaponPicks: WeaponPick[] = [],
  exoticHash?: Hash,
): SolverState {
```

Replace the `build` literal (lines 165-170) with:

```ts
  const build: Build = {
    ...env.base,
    subclass: { ...env.base.subclass, fragmentHashes: frag },
    // `?? env.base.armor.exoticHash` keeps a base-pinned exotic when this dimension is closed.
    armor: { ...env.base.armor, exoticHash: exoticHash ?? env.base.armor.exoticHash },
    artifact: { ...env.base.artifact, selectedPerkHashes: perk },
    weapons,
  };
```

Replace the `candidates` / `addable` block (lines 173-181) with:

```ts
  const candidates = generateCandidates(env, frag, perk, cap, weaponPicks, exoticHash);
  // Open-slot bound: augment the addable set with each not-yet-decided dimension's
  // precomputed reachable-union (candidates alone under-cover a dimension still open).
  const addable = candidates
    // weapon- and exotic-selection tags are covered by their reach unions below
    .filter((c) => c.kind !== "weapon" && c.kind !== "exoticArmor")
    .map((c) => c.element);
  for (const slot of env.openWeaponSlots) {
    if (!pickBySlot.has(slot)) addable.push(...(env.weaponReach.get(slot) ?? []));
  }
  if (exoticHash === undefined && env.exoticPool.length > 0) addable.push(...env.exoticReach);
```

Replace the return (lines 183-184) with:

```ts
  const priority = bound(build, addable, env.lookup);
  return { build, fragHashes: frag, perkHashes: perk, cap, realized, candidates, priority,
    weapons: weaponPicks, exoticHash, key: stateKey(frag, perk, weaponPicks, exoticHash) };
```

- [ ] **Step 7: Handle the move in `expand`**

Replace the whole body of `expand` (lines 188-209) with:

```ts
export function expand(state: SolverState, env: SolverEnv, bound: BoundFn): SolverState[] {
  const out: SolverState[] = [];
  for (const c of state.candidates) {
    if (c.kind === "fragment") {
      out.push(makeState(env, [...state.fragHashes, c.hash], state.perkHashes, bound, state.weapons, state.exoticHash));
    } else if (c.kind === "artifactPerk") {
      out.push(makeState(env, state.fragHashes, [...state.perkHashes, c.hash], bound, state.weapons, state.exoticHash));
    } else if (c.kind === "exoticArmor") {
      out.push(makeState(env, state.fragHashes, state.perkHashes, bound, state.weapons, c.hash));
    } else if (c.kind === "weapon") {
      // Choose a weapon for slot c.slot. Eager ammo prune: skip if it makes the
      // no-double-Primary rule unsatisfiable across all decided weapons.
      const decided = decidedAmmo(env, [...state.weapons, { slot: c.slot!, itemHash: c.hash, plugHashes: [] }]);
      if (nonPowerAmmoInfeasible(decided)) continue;
      out.push(makeState(env, state.fragHashes, state.perkHashes, bound,
        [...state.weapons, { slot: c.slot!, itemHash: c.hash, plugHashes: [] }], state.exoticHash));
    } else { // weaponPerk
      const nextPicks = state.weapons.map((p) =>
        p.slot === c.slot ? { ...p, plugHashes: [...p.plugHashes, c.hash] } : p);
      out.push(makeState(env, state.fragHashes, state.perkHashes, bound, nextPicks, state.exoticHash));
    }
  }
  return out;
}
```

**Every branch forwards `state.exoticHash`.** Omitting it on any one branch silently drops an already-chosen exotic the moment a fragment, perk, weapon, or plug is added next — a state-corruption bug that no type error catches.

- [ ] **Step 8: Extend the terminal guard**

In `beamSearch`, replace the guard (lines 267-269) with:

```ts
        // Also require the exotic decided when its dimension is open, for the same reason
        // the weapon guard exists: a dimension left forever undecided is a dead end, not a
        // deliverable.
        if (state.weapons.length === env.openWeaponSlots.length
            && (state.exoticHash !== undefined || env.exoticPool.length === 0)) {
          completed.push(state);
        }
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run tests/solver/beam-exotic-wiring.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 10: Run the full trio**

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`
Expected: all green. Every pre-existing solver test must pass **unchanged** — that is the byte-compatibility guarantee. If any fails, the additive contract is broken; fix the code, not the test.

- [ ] **Step 11: Commit**

```bash
git add src/lib/solver/beam.ts tests/solver/beam-exotic-wiring.test.ts
git commit -m "feat(solver): wire the exotic armor dimension into the beam

SolverEnv gains exoticPool + exoticReach, SolverState gains exoticHash, stateKey
appends an |exo: component only when present (so SP3a/slice-1 keys stay
byte-identical), and the terminal guard requires the exotic decided when its
dimension is open — the same dead-end reasoning as slice 1's weapon guard.

A non-empty pool is exactly equivalent to 'the dimension is open': buildSolverEnv
returns null when it is open but admits nothing, so no separate flag exists to
drift out of sync. Every expand() branch forwards state.exoticHash; missing it on
any branch would silently drop a chosen exotic on the next unrelated move."
```

---

### Task 5: Real-data cost measurement (DO NOT DEFER)

Spec review finding 2: this runs **immediately** after the wiring, before the acceptance gate and integration work, so the remaining tasks are not built on an unverified cost assumption. `exoticReach` puts ~38 tagged elements into `addable` where a real build contributes one exotic; slice 2a showed such inflation can cost 6×.

**Files:**
- Create: `tests/solver/integration-exotic.test.ts` (cost tripwire only; Task 7 adds the rest)

**Interfaces:**
- Consumes: `solve` from `@/lib/solver`; `synergyUpperBound` from `@/lib/synergy`; `loadDataset`.
- Produces: a committed ceiling constant for the exotic dimension.

- [ ] **Step 1: Confirm the existing weapons tripwire is still exactly 10,842**

Temporarily add a log to a **copy** so the tracked file is untouched:

```bash
sed 's/expect(calls).toBeLessThan(25_000);/console.log("BOUND_CALLS=" + calls); expect(calls).toBeLessThan(25_000);/' \
  tests/solver/integration-weapons.test.ts > tests/solver/__cost.tmp.test.ts
npx vitest run tests/solver/__cost.tmp.test.ts --reporter=verbose 2>&1 | grep BOUND_CALLS
rm -f tests/solver/__cost.tmp.test.ts
```

Expected: `BOUND_CALLS=10842` **exactly**. That build fixture pins no `classType`, so the exotic dimension must be closed and the cost unchanged. A different number means the change is not additive — stop and fix Task 4 before continuing.

- [ ] **Step 2: Write the cost test with a deliberately-failing ceiling**

Create `tests/solver/integration-exotic.test.ts`:

```ts
import { existsSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import type { Build, DerivedDataset } from "@/lib/types";
import { createLookup, type Lookup } from "@/lib/validation";
import { synergyUpperBound } from "@/lib/synergy";
import type { BuildElement } from "@/lib/synergy";
import { solve, type SolverContext } from "@/lib/solver";

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));

// Set from the MEASURED run in step 4. Placeholder 1 forces the first run to fail loudly
// rather than silently passing an unmeasured ceiling.
const EXOTIC_BOUND_CALL_CEILING = 1;

describe.runIf(hasDataset)("solve — exotic armor dimension (real data)", () => {
  let ds: DerivedDataset;
  let ctx: SolverContext;

  beforeAll(async () => {
    ds = await loadDataset();
    ctx = { lookup: createLookup(ds), indexes: ds.indexes };
  });

  /** Warlock, arc, one fragment-granting aspect, one artifact. No weapons, no pins. */
  const fixture = (): Build => {
    const aspect = ds.aspects.find((a) => a.element === "arc" && a.fragmentSlots > 0);
    const artifact = ds.artifacts[0];
    if (!aspect || !artifact) throw new Error("expected an arc aspect + an artifact");
    return {
      subclass: { element: "arc", classType: "warlock", aspectHashes: [aspect.hash], fragmentHashes: [] },
      weapons: [],
      armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
      artifact: { artifactHash: artifact.hash, selectedPerkHashes: [] },
      constraints: [],
    } as unknown as Build;
  };

  it("stays under the measured bound-call ceiling", () => {
    let calls = 0;
    const counting = (present: Build, addable: BuildElement[], lu: Lookup) => {
      calls++;
      return synergyUpperBound(present, addable, lu);
    };
    const result = solve(fixture(), ctx, { beamWidth: 8, topN: 3, bound: counting });
    expect(result.feasible).toBe(true);
    expect(result.builds.length).toBeGreaterThan(0);
    console.log("EXOTIC_BOUND_CALLS=" + calls);
    expect(calls).toBeLessThan(EXOTIC_BOUND_CALL_CEILING);
  });
});
```

- [ ] **Step 3: Run it and read the measured number**

Run: `npx vitest run tests/solver/integration-exotic.test.ts --reporter=verbose 2>&1 | grep -E "EXOTIC_BOUND_CALLS|Tests"`
Expected: FAIL on the ceiling, with `EXOTIC_BOUND_CALLS=<N>` printed. Record `<N>`.

- [ ] **Step 4: Set the ceiling from the measurement, and decide**

Set `EXOTIC_BOUND_CALL_CEILING` to roughly **2× the measured `<N>`**, rounded to a readable number, and replace the placeholder comment with the measured value:

```ts
// OBSERVED on this dataset (deterministic across runs): <N> calls. Ceiling ~2x for
// season-drift headroom. The exotic dimension adds a ~38-element reach union where a real
// build contributes ONE exotic, so this is the tripwire for that looseness.
const EXOTIC_BOUND_CALL_CEILING = <2N rounded>;
```

Also delete the `console.log` line once recorded.

**Decision gate.** If `<N>` exceeds ~150,000 (roughly 14× the weapons baseline), the looseness is not acceptable. Do **not** redesign — apply the pre-decided response from the spec: require a `useExotic` pin, i.e. treat the dimension as open only when a pin is present, and record the change plus the measured number in the plan and spec. Report to the user before proceeding.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`

```bash
git add tests/solver/integration-exotic.test.ts
git commit -m "test(solver): measure and pin the exotic dimension's bound-call cost

Front-loaded per the spec's review finding: exoticReach contributes ~38 tagged
elements to addable where a real build contributes ONE exotic (~38x over-credit),
and slice 2a showed inflated producer counts can blow the bound up 6x. Measuring
here rather than at the end means the remaining tasks are not built on an
unverified cost assumption.

Measured <N> bound calls; ceiling set at ~2x for season-drift headroom. The
existing weapons tripwire still measures exactly 10,842, confirming the exotic
dimension is closed when no classType is pinned."
```

---

### Task 6: The acceptance gate

**Files:**
- Create: `tests/solver/beam-exotic.test.ts`

**Interfaces:**
- Consumes: `beamSearch`, `buildSolverEnv` from `@/lib/solver/beam`; `synergyUpperBound`.
- Produces: nothing downstream — this is the slice's proof of value.

The gate: an exotic whose produced keyword is consumed **only** by a fragment must survive the beam at `beamWidth: 1`, where realized synergy is still 0 at the moment it is chosen. With a zero bound it must be pruned in favour of the lexically-smaller inert path. Both directions are asserted, so the test cannot pass vacuously.

- [ ] **Step 1: Write the failing test**

Create `tests/solver/beam-exotic.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import { synergyUpperBound } from "@/lib/synergy";
import type { Armor, Artifact, Aspect, Build, DerivedDataset, Fragment } from "@/lib/types";
import { EMPTY_TAGS } from "@/lib/types";

import { beamSearch, buildSolverEnv } from "@/lib/solver/beam";
import type { SolverContext } from "@/lib/solver";

const EMPTY_INDEXES = {
  keyword: { producers: {}, consumers: {} },
  perkToWeapons: {}, elementToItems: {}, setToPieces: {},
  exoticToClassSlot: {}, slotToWeapons: {},
};

const tag = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });

// ONE fragment slot, and an artifact with no perks — so the exotic + the single chosen
// fragment are the only things that can ever form synergy in this fixture.
const aspect100: Aspect = {
  kind: "aspect", hash: 100, name: "Asp", element: "arc", classType: "any",
  fragmentSlots: 1, tags: EMPTY_TAGS,
};
const artifact300: Artifact = {
  kind: "artifact", hash: 300, name: "Art", tiers: [{ tierIndex: 0, slots: 0, perks: [] }],
};

// Inert fragment has the LOWER hash, so a key-only tie-break prefers it.
const fragInert: Fragment = {
  kind: "fragment", hash: 400, name: "FragInert", icon: "", element: "arc",
  statModifiers: [], tags: EMPTY_TAGS,
};
const fragConsumer: Fragment = {
  kind: "fragment", hash: 401, name: "FragCons", icon: "", element: "arc",
  statModifiers: [], tags: tag({ consumes: ["jolt"] }),
};

// Inert exotic has the LOWER hash, for the same reason.
const exoInert: Armor = {
  kind: "armor", hash: 800, name: "ExoInert", icon: "", slot: "helmet", tier: "exotic",
  classType: "warlock", modSocketHashes: [], tags: EMPTY_TAGS,
} as Armor;
const exoProducer: Armor = {
  kind: "armor", hash: 801, name: "ExoProd", icon: "", slot: "arms", tier: "exotic",
  classType: "warlock", modSocketHashes: [], tags: tag({ produces: ["jolt"] }),
} as Armor;

function ctxFor(): SolverContext {
  const armorPieces = [exoInert, exoProducer];
  const exoticToClassSlot: Record<number, { classType: string; slot: string }> = {};
  for (const a of armorPieces) exoticToClassSlot[a.hash] = { classType: a.classType, slot: a.slot };
  const ds = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [aspect100], fragments: [fragInert, fragConsumer],
    weapons: [], armor: armorPieces, armorSets: [], mods: [], artifacts: [artifact300],
    perks: [], stats: [], plugTags: {},
    indexes: {
      ...EMPTY_INDEXES,
      elementToItems: { arc: [fragInert.hash, fragConsumer.hash] },
      exoticToClassSlot,
    },
  } as unknown as DerivedDataset;
  return { lookup: createLookup(ds), indexes: ds.indexes };
}

const pinnedBuild = (): Build => ({
  subclass: { element: "arc", classType: "warlock", aspectHashes: [100], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { artifactHash: 300, selectedPerkHashes: [] },
  constraints: [],
}) as unknown as Build;

const ZERO_BOUND = () => 0;

describe("beamSearch — exotic armor delayed reward", () => {
  it("bound ON, W=1: keeps the producing exotic whose only consumer is a fragment", () => {
    const env = buildSolverEnv(pinnedBuild(), ctxFor(), { beamWidth: 1 })!;
    expect(env).toBeTruthy();
    const completed = beamSearch(env, synergyUpperBound);
    expect(completed).toHaveLength(1);
    expect(completed[0].build.armor.exoticHash).toBe(801);
    expect(completed[0].build.subclass.fragmentHashes).toEqual([401]);
    expect(completed[0].realized.score).toBeGreaterThan(0);
  });

  it("ZERO_BOUND, W=1: prunes it, settling on the lexically-smallest inert path", () => {
    const env = buildSolverEnv(pinnedBuild(), ctxFor(), { beamWidth: 1 })!;
    const completed = beamSearch(env, ZERO_BOUND);
    expect(completed).toHaveLength(1);
    expect(completed[0].build.armor.exoticHash).toBe(800);
    expect(completed[0].build.subclass.fragmentHashes).toEqual([400]);
    expect(completed[0].realized.score).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/solver/beam-exotic.test.ts`
Expected: PASS (2 tests). The two assertions produce **opposite** winners — `801/401` with the bound, `800/400` without — which is what makes the gate load-bearing rather than vacuous.

If the zero-bound case also returns `801`, the gate is vacuous: the fixture's tie-break is not actually favouring the inert path. Fix the fixture (hash ordering) before continuing — do not weaken the assertion.

- [ ] **Step 3: Prove the gate is load-bearing by mutation**

Slice 2a's lesson: a passing test can encode the same wrong assumption as the code. Temporarily break the bound's reach contribution and confirm the gate turns red. Back the file up in the **scratchpad**, not `/tmp`, and **`grep` to confirm the `sed` actually applied** before trusting the result — a `sed` that silently matches nothing leaves the file intact, the test green, and that reads identically to "the mutation didn't matter".

```bash
cp src/lib/solver/beam.ts "$SCRATCH/beam.bak"
sed -i 's/  if (exoticHash === undefined \&\& env.exoticPool.length > 0) addable.push(...env.exoticReach);/  \/\/ mutated/' src/lib/solver/beam.ts
grep -c "addable.push(...env.exoticReach)" src/lib/solver/beam.ts   # MUST be 0
npx vitest run tests/solver/beam-exotic.test.ts 2>&1 | grep -E "^ +Tests "
cp "$SCRATCH/beam.bak" src/lib/solver/beam.ts
git diff --stat src/lib/solver/beam.ts   # MUST be empty
```

**⚠️ MEASURED CORRECTION (2026-07-28) — the original expectation here was WRONG, do not restore it.**

This step used to expect the mutated run to fail the bound-ON case. **It does not.** Measured: with `exoticReach` removed (mutation confirmed applied by `grep`), both tests in this file still pass, winners unchanged at `801`/`401` and `800`/`400`.

*Why, and it is structural rather than a fixture defect:* the exotic dimension is **single-stage and always selectable**, so "choose the exotic first" is a sibling of every other path from the root. That sibling has the producing exotic in `present` (via `collectBuildElements` reading `armor.exoticHash`) and the consuming fragment in `addable` as an ordinary fragment candidate — reaching the same bound (1.5) through the normal candidate path, with no `exoticReach` involved. Every completion is therefore reachable via an exotic-decided sibling whose bound is correct without the reach term, so removing it cannot prune the optimum. **No outcome-based fixture can prove `exoticReach` load-bearing.** Do not attempt to build one; the two tests above are still worth keeping, but what they prove is that *the bound as a whole* is load-bearing versus a zero bound — not that the reach term is.

- [ ] **Step 3b: Pin `exoticReach` with an ADMISSIBILITY property test (this is the real gate)**

`exoticReach` is load-bearing for **admissibility**, which is a property of the bound rather than of the search outcome — and admissibility is the invariant all of SP3a's pruning correctness rests on. Assert it directly: for a state `S` whose exotic is **undecided**, `S.priority` must dominate the realized score of every completion of `S`.

Add to `tests/solver/beam-exotic.test.ts`, reusing the fixture above:

```ts
describe("synergyUpperBound — admissibility over the exotic dimension", () => {
  // THE gate for exoticReach. Outcome-based tests cannot catch its removal (see the plan's
  // Step 3), because a chosen exotic lands in `present` and its consumer is an ordinary
  // fragment candidate. But dropping the reach term makes the bound UNDER-estimate an
  // exotic-undecided state, breaking the admissibility SP3a's pruning depends on.
  it("bound on an exotic-undecided state dominates every completion's realized score", () => {
    const ctx = ctxFor();
    const env = buildSolverEnv(pinnedBuild(), ctx, { beamWidth: 1 })!;
    // Consumer fragment chosen; exotic still open.
    const s = makeState(env, [401], [], synergyUpperBound, [], undefined);
    const realized = [800, 801].map((h) =>
      scoreSynergy({ ...s.build, armor: { ...s.build.armor, exoticHash: h } } as Build, env.lookup).score);
    // MEASURED: bound 1.5 vs best completion 1. Mutating exoticReach away drops the bound to
    // 0 while the completion still realizes 1 — inadmissible, and this assertion goes red.
    expect(s.priority).toBeGreaterThanOrEqual(Math.max(...realized));
  });
});
```

Needs `makeState` and `scoreSynergy` imported. **Mutation-prove this one** with the same procedure as Step 3: `grep`-confirm the mutation applied, expect this test RED (bound `1.5 → 0`, best completion `1`), restore, expect green, `git diff` empty.

- [ ] **Step 4: Run the full trio and commit**

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`

```bash
git add tests/solver/beam-exotic.test.ts
git commit -m "test(solver): acceptance gate for exotic-armor delayed reward

An exotic whose produced keyword is consumed ONLY by a fragment survives the beam
at W=1 — where its realized synergy is still 0 when chosen — and is pruned with a
zero bound in favour of the lexically-smaller inert path. The two runs produce
OPPOSITE winners (801/401 vs 800/400), so the gate cannot pass vacuously.

The reach term needs a different instrument. Removing exoticReach does NOT change
either outcome above: the exotic dimension is single-stage and always selectable,
so 'choose the exotic first' is a sibling of every path, carrying the producer in
present and the consumer as an ordinary fragment candidate. Every completion stays
reachable via a sibling whose bound is correct without the reach term, so no
outcome-based fixture can prove it load-bearing. An admissibility property test
pins it instead: on an exotic-undecided state the bound must dominate every
completion's realized score, which mutation turns red (1.5 -> 0 against a
completion realizing 1)."
```

---

### Task 7: Real-data integration + barrel export

**Files:**
- Modify: `tests/solver/integration-exotic.test.ts` (add integration cases beside the cost tripwire)
- Modify: `src/lib/solver/index.ts` (export the new pool helper for consumers/tests)

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: `deriveExoticArmorPool` on the public solver barrel.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe.runIf(hasDataset)` block in `tests/solver/integration-exotic.test.ts`:

```ts
  it("chooses a class-correct, tagged exotic", () => {
    const result = solve(fixture(), ctx, { beamWidth: 8, topN: 3 });
    expect(result.feasible).toBe(true);
    expect(result.builds.length).toBeGreaterThan(0);
    const chosen = result.builds[0].build.armor.exoticHash;
    expect(chosen).toBeDefined();
    const piece = ctx.lookup.armor(chosen!)!;
    expect(piece.tier).toBe("exotic");
    expect(piece.classType).toBe("warlock");
  });

  it("scores at least as well as the same build with the exotic dimension closed", () => {
    const withExotic = solve(fixture(), ctx, { beamWidth: 8, topN: 1 });
    const closed = { ...fixture() } as Build;
    (closed.subclass as { classType?: string }).classType = undefined;
    const withoutExotic = solve(closed, ctx, { beamWidth: 8, topN: 1 });
    expect(withoutExotic.feasible).toBe(true);
    expect(withExotic.builds[0].score).toBeGreaterThanOrEqual(withoutExotic.builds[0].score);
  });

  it("honours a useExotic pin", () => {
    const base = fixture();
    const pool = ds.armor.filter((a) => a.tier === "exotic" && a.classType === "warlock");
    const pin = pool[0].hash;
    const pinned = { ...base, constraints: [{ kind: "useExotic", itemHash: pin }] } as unknown as Build;
    const result = solve(pinned, ctx, { beamWidth: 8, topN: 1 });
    expect(result.feasible).toBe(true);
    expect(result.builds[0].build.armor.exoticHash).toBe(pin);
  });

  it("is infeasible when the pin contradicts the pinned class", () => {
    const titan = ds.armor.find((a) => a.tier === "exotic" && a.classType === "titan")!;
    const bad = {
      ...fixture(), constraints: [{ kind: "useExotic", itemHash: titan.hash }],
    } as unknown as Build;
    const result = solve(bad, ctx, { beamWidth: 8, topN: 1 });
    expect(result.feasible).toBe(false);
    expect(result.builds).toEqual([]);
  });

  it("re-validates: the completed build has no game violations from the armor rules", async () => {
    const { validateBuild } = await import("@/lib/validation");
    const result = solve(fixture(), ctx, { beamWidth: 8, topN: 1 });
    const violations = validateBuild(result.builds[0].build, ctx.lookup)
      .violations.filter((v) => v.category === "game" && v.subject.kind === "armor");
    expect(violations).toEqual([]);
  });
```

- [ ] **Step 2: Run to verify the new cases fail or pass as expected**

Run: `npx vitest run tests/solver/integration-exotic.test.ts`
Expected: all PASS if Tasks 1-6 are correct. A failure here is a real defect in the wiring, not a test problem — investigate the code first.

The `>=` in the score comparison is deliberate: the closed-dimension build is a strict subset of the open one's reachable set, so the open search can never score lower, but it may tie when no exotic carries a useful keyword for that element.

- [ ] **Step 3: Export the pool helper from the barrel**

In `src/lib/solver/index.ts`, update the docstring and add the export:

```ts
/**
 * Solver seam. Completes a partially-pinned build via beam search over subclass
 * fragments, artifact perks, weapon selection + roll, and exotic armor, ranked by
 * synergy (SP1) + a stubbed stat-fit seam (SP4). Pure and dependency-injected: all
 * data arrives via `SolverContext`.
 */

export { solve } from "./solve";
export { neutralStatFit } from "./stat-fit";
export { deriveExoticArmorPool } from "./armor";
export type {
  BoundFn,
  RankedBuild,
  SolveOptions,
  SolveResult,
  SolverContext,
  StatFit,
} from "./types";
```

- [ ] **Step 4: Run the full trio**

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`
Expected: all green. Record the final test + file count.

- [ ] **Step 5: Record the measured cost in the spec**

In `docs/superpowers/specs/2026-07-27-phase2-sp3b-slice2b-exotic-armor-solver-design.md`, under "Done means", replace the sentence about the new dimension's measured cost with the actual number from Task 5, and delete the 16k–33k estimate wording so no future reader mistakes an estimate for a measurement.

- [ ] **Step 6: Commit**

```bash
git add tests/solver/integration-exotic.test.ts src/lib/solver/index.ts docs/superpowers/specs/2026-07-27-phase2-sp3b-slice2b-exotic-armor-solver-design.md
git commit -m "test(solver): real-data integration for the exotic armor dimension

Asserts a class-correct tagged exotic is chosen, that opening the dimension never
scores worse than leaving it closed, that a useExotic pin is honoured, that a pin
contradicting the pinned class is infeasible, and that the completed build draws
no game-category armor violations.

Exports deriveExoticArmorPool from the solver barrel and replaces the spec's
cost estimate with the measured figure."
```

---

## After the plan

Slice 2b ends here. Remaining SP3b work, in order:

- **Slice 2c — mods.** Needs a mod capacity oracle first, and that needs ingest data we do not emit: a socket-type → accepted-plug-category mapping. Armour carries `modSocketHashes` (exotics mostly 6–7 sockets, 52 distinct socket types) but nothing says which mods those sockets accept. Precedent: SP3a could only choose artifact perks because SP2 built the capacity oracle first. Mods are the same shape — a flat selection under per-category capacity — **except the structure is categorical, not nested**, so SP2's upward-closed Hall's-condition shortcut does not transfer. 145 of 512 mods carry tags; none carry `championStuns`.
- **Set bonuses** — the user flagged these as likely next after mods.
- **Slice 3** — solver-chosen artifact (all 7) + solver-chosen aspects. Now has a class source from this slice, since aspect pools are class-specific too. Must revisit SP3a's terminal-only routing if dynamic fragment caps ever permit underfill.
- **Slice 4** — full infeasibility explanation. This slice adds three new infeasible causes (pin/class contradiction, unknown pinned hash, empty class pool) that currently collapse into a bare `feasible: false`.

Then refresh `docs/HANDOFF.md` with the measured cost and the new surface before starting the next slice.
