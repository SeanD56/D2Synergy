# Set-Bonus Dimension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The solver chooses which armour set bonuses a build should TARGET, behind a new
`armor.targetedSetBonuses` field, so that 58 tagged set bonuses enter the synergy graph without
weakening the existing `setBonusCounts` rule.

**Architecture:** One new open dimension on the existing beam, using add-one-target moves (≤2 extra
levels). A decision is a `(setHash, pieceCount)` pair because thresholds are CUMULATIVE — 4 pieces
fire both the 2-piece and 4-piece bonuses. Candidates are exactly one move per tagged bonus (58).
The dimension is additive: a `|set:` key segment is appended only when non-empty, so every state key
written before this slice stays byte-identical.

**Tech Stack:** TypeScript, Vitest, Next.js 16 (App Router, React Server Components), Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-07-29-phase2-sp3b-set-bonus-dimension-design.md` — read it
before Task 1. Where this plan and the spec disagree, **this plan wins** (it carries the reviewed
code); the one deliberate deviation is called out in Task 1, Step 1.

## Global Constraints

- **Verify with:** `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`, plus
  `npx next build` for any UI change.
- **Baseline that must not regress: 424 passing tests, 53 files, 0 failing.** Anything less is a
  regression. Task 7 records the new expected count.
- **Weapons cost tripwire: exactly 10,527 bound calls.** Re-verify in Task 7.
- **Existing marginal factors, for comparison:** exotic 2.72×, aspect 1.21×, mods 5.37×.
- **`setBonusCounts` in `src/lib/validation/armor.ts` MUST NOT be modified.** The whole point of the
  field split is that no existing rule is weakened. If a task seems to require changing it, stop and
  re-read the spec's "The blocker, precisely" section.
- **Do NOT dedup reach by tag signature.** Slice 2c did this for mods; here it would make the bound
  inadmissible, because two different sets can produce the same keyword. See Task 2, Step 3.
- **Mutation discipline:** when a step says "prove by mutation", apply the mutation, **`grep`-confirm
  the edit actually landed**, run the test, then revert and `grep`-confirm the revert. A mutation
  that fails to apply reads exactly like one that did not matter — it hid two real bugs in slice 2c.
  Use `python3` rather than `sed` when the target text contains shell or regex metacharacters.
- **Commit after every task.** Work on `main` unless the handoff says otherwise.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/lib/types/build.ts` | **Modify** — `TargetedSetBonus`, `SET_PIECE_BUDGET`, `ArmorLoadout.targetedSetBonuses?` | 1 |
| `src/lib/validation/types.ts` | **Modify** — add `SET_TARGET_INVALID` to `ViolationCode` | 1 |
| `src/lib/validation/armor.ts` | **Modify** — new `targetedSetBonusPlan` rule + register in `armorRules` | 1 |
| `tests/validation/armor.test.ts` | **Modify** — rule tests, incl. the zero-`game`-violations assertion | 1 |
| `src/lib/solver/set-bonuses.ts` | **Create** — pool, reach, budget arithmetic | 2 |
| `tests/solver/set-bonuses.test.ts` | **Create** — pool/reach/budget unit tests + real-data bounds | 2 |
| `src/lib/synergy/elements.ts` | **Modify** — cumulative activation into `collectBuildElements` | 3 |
| `tests/synergy/elements-set-bonuses.test.ts` | **Create** — the cumulative-threshold mechanic | 3 |
| `src/lib/solver/types.ts` | **Modify** — `SolveOptions.chooseSetBonuses` | 4 |
| `src/lib/solver/candidates.ts` | **Modify** — `setBonus` candidate kind + emission | 4 |
| `src/lib/solver/beam.ts` | **Modify** — env, `Selection`, `stateKey`, `expand`, `makeState`, `dimensionsAllDecided` | 4 |
| `tests/solver/beam-set-bonuses.test.ts` | **Create** — key serialisation, opt-in wiring, budget gating | 4 |
| (same file) | **Modify** — the synthetic admissibility gate | 5 |
| `src/lib/solver/beam.ts` | **Modify** — `SET_TARGET_PLAN_ILLEGAL` for pinned illegal plans | 6 |
| `tests/solver/infeasibility.test.ts` | **Modify** — pinned-illegal-plan reasons | 6 |
| `tests/solver/integration-set-bonuses.test.ts` | **Create** — real data, plan arithmetic, cost, tripwire | 7 |
| `src/lib/ui/recommend.ts` | **Modify** — `BuildDisplay.setBonusNames` | 8 |
| `src/app/page.tsx` | **Modify** — one `Set bonuses` row | 8 |
| `tests/ui/recommend.test.ts` | **Modify** — display assertions | 8 |

---

### Task 1: The build-model type, the violation code, and the validator rule

**Files:**
- Modify: `src/lib/types/build.ts` (after `ActiveSetBonus`, currently at lines 55-59)
- Modify: `src/lib/validation/types.ts:34` (the `ViolationCode` union)
- Modify: `src/lib/validation/armor.ts` (add a rule; register it in `armorRules` at lines 178-183)
- Test: `tests/validation/armor.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `TargetedSetBonus { setHash: Hash; pieceCount: number }` and
  `SET_PIECE_BUDGET = 4`, both exported from `src/lib/types/build.ts` and re-exported by
  `@/lib/types`. `ArmorLoadout.targetedSetBonuses?: TargetedSetBonus[]`. Violation code
  `"SET_TARGET_INVALID"`.

**⚠️ DELIBERATE DEVIATION FROM THE SPEC.** The spec puts `SET_PIECE_BUDGET` in
`src/lib/solver/set-bonuses.ts`. It goes in `src/lib/types/build.ts` instead, because the validator
needs it too and **validation must not import the solver** — the dependency runs the other way
(`src/lib/solver/beam.ts` imports from `@/lib/validation`). `src/lib/types` is the shared floor where
`EMPTY_TAGS` already lives.

- [ ] **Step 1: Add the type and the constant**

In `src/lib/types/build.ts`, directly after the `ActiveSetBonus` interface:

```typescript
/**
 * Legendary armour slots available for set pieces: 5 armour slots minus the exotic.
 *
 * Deliberately a constant rather than a per-build computation. With no exotic chosen there are 5
 * legendary slots, but NO legal plan costs 3 or 5 pieces — the only combination that could use a
 * fifth is `{A:4, B:2}` at 6 — so the reachable plan space is identical either way and a
 * state-dependent budget would buy nothing. Lives here rather than in the solver because the
 * validator needs it and validation must not depend on the solver.
 */
export const SET_PIECE_BUDGET = 4;

/**
 * A set bonus the build is TARGETING — a goal, not a state.
 *
 * Distinct from `ActiveSetBonus` on purpose, and the distinction is load-bearing:
 * `ActiveSetBonus` claims "this bonus IS active", which `setBonusCounts` validates against the
 * pieces in `armor.pieces`. The solver never writes `armor.pieces` (that is SP4's job), so a
 * prescribed bonus written to `setBonuses` fails on every solver-produced build. This field claims
 * only "obtain this many pieces of this set", which is checkable without knowing the pieces.
 *
 * `pieceCount` is 2 or 4, and thresholds are CUMULATIVE: 4 pieces fire the set's 2-piece bonus as
 * well as its 4-piece bonus. So one entry per set is sufficient and `{A:2, A:4}` is not a distinct
 * plan — it IS `{A:4}`.
 */
export interface TargetedSetBonus {
  setHash: Hash;
  /** Pieces to obtain: 2 or 4. */
  pieceCount: number;
}
```

Then add the field to `ArmorLoadout` (currently lines 88-94), after `setBonuses`:

```typescript
  /**
   * Set bonuses the build is TARGETING, as opposed to `setBonuses` which are ACTIVE.
   *
   * Optional so the 32 existing `ArmorLoadout` literals across 27 files stay valid; inside the
   * solver's `Selection` the equivalent field is REQUIRED, which is where forwarding bugs live.
   */
  targetedSetBonuses?: TargetedSetBonus[];
```

Confirm `src/lib/types/index.ts` re-exports `./build` with a `export *`-style barrel; if it names
exports explicitly, add `SET_PIECE_BUDGET` and `TargetedSetBonus` to that list.

- [ ] **Step 2: Add the violation code**

In `src/lib/validation/types.ts`, add to the `ViolationCode` union immediately after
`"SET_COUNT_INVALID"` (line 34):

```typescript
  | "SET_TARGET_INVALID"
```

- [ ] **Step 3: Write the failing tests**

Add to `tests/validation/armor.test.ts`. Match the file's existing helper style for building a
`Build`; if it has a local `armorBuild(...)`-style factory, use it and pass
`targetedSetBonuses` through. Otherwise use a local literal as below.

```typescript
describe("targetedSetBonusPlan", () => {
  // A build carrying ONLY targets and no pieces — exactly what the solver produces.
  const targeted = (targetedSetBonuses: { setHash: number; pieceCount: number }[]): Build => ({
    subclass: { element: "arc", classType: "warlock", aspectHashes: [], fragmentHashes: [] },
    weapons: [],
    armor: {
      pieces: [], setBonuses: [], statPriorities: [], modHashes: [],
      exoticHash: EXOTIC_HASH, targetedSetBonuses,
    },
    artifact: { artifactHash: ARTIFACT_HASH, selectedPerkHashes: [] },
    constraints: [],
  }) as unknown as Build;

  // THE assertion that proves the field split works. Written to `setBonuses` this emits
  // SET_COUNT_INVALID on every solver build, because the solver never writes `armor.pieces`.
  it("accepts a solver-shaped build with targets and NO pieces, with zero game violations", () => {
    const result = validateBuild(targeted([{ setHash: SET_A, pieceCount: 4 }]), lookup);
    const game = result.violations.filter((v) => v.category === "game");
    expect(game).toEqual([]);
  });

  it("accepts each legal plan shape", () => {
    for (const plan of [
      [],
      [{ setHash: SET_A, pieceCount: 2 }],
      [{ setHash: SET_A, pieceCount: 4 }],
      [{ setHash: SET_A, pieceCount: 2 }, { setHash: SET_B, pieceCount: 2 }],
    ]) {
      const codes = validateBuild(targeted(plan), lookup).violations.map((v) => v.code);
      expect(codes, JSON.stringify(plan)).not.toContain("SET_TARGET_INVALID");
    }
  });

  it("rejects a plan needing more than 4 pieces", () => {
    const codes = validateBuild(
      targeted([{ setHash: SET_A, pieceCount: 4 }, { setHash: SET_B, pieceCount: 2 }]),
      lookup,
    ).violations.map((v) => v.code);
    expect(codes).toContain("SET_TARGET_INVALID");
  });

  it("rejects a threshold that is not 2 or 4", () => {
    const codes = validateBuild(targeted([{ setHash: SET_A, pieceCount: 3 }]), lookup)
      .violations.map((v) => v.code);
    expect(codes).toContain("SET_TARGET_INVALID");
  });

  it("rejects the same set targeted twice, since thresholds are cumulative", () => {
    const codes = validateBuild(
      targeted([{ setHash: SET_A, pieceCount: 2 }, { setHash: SET_A, pieceCount: 2 }]),
      lookup,
    ).violations.map((v) => v.code);
    expect(codes).toContain("SET_TARGET_INVALID");
  });

  it("rejects a set hash absent from the dataset", () => {
    const codes = validateBuild(targeted([{ setHash: 424242, pieceCount: 2 }]), lookup)
      .violations.map((v) => v.code);
    expect(codes).toContain("SET_TARGET_INVALID");
  });

  it("is inert when the field is absent, so no existing build changes verdict", () => {
    const build = targeted([]);
    delete (build.armor as { targetedSetBonuses?: unknown }).targetedSetBonuses;
    const codes = validateBuild(build, lookup).violations.map((v) => v.code);
    expect(codes).not.toContain("SET_TARGET_INVALID");
  });
});
```

`SET_A` and `SET_B` must be two real `armorSets` hashes from the test lookup, and `EXOTIC_HASH` /
`ARTIFACT_HASH` whatever the file already uses to keep the *other* armour rules quiet. **Read the top
of `tests/validation/armor.test.ts` first** and reuse its existing fixture constants; if it builds
against the real dataset, take the first two `armorSets` entries.

- [ ] **Step 4: Run the tests and verify they fail**

Run: `npx vitest run tests/validation/armor.test.ts`
Expected: the six `SET_TARGET_INVALID` tests FAIL (the code is never emitted, so `toContain` fails).
The "zero game violations" and "inert when absent" tests may already PASS — that is expected and
correct: they are regression guards, not drivers.

- [ ] **Step 5: Implement the rule**

In `src/lib/validation/armor.ts`, add after `setBonusCounts` (do NOT touch `setBonusCounts`):

```typescript
/**
 * The TARGETED set-bonus plan is internally legal.
 *
 * Deliberately says nothing about `armor.pieces` — that is `setBonusCounts`' job for ACTIVE
 * bonuses. A target is a goal, so it is checkable without knowing which pieces are worn, which is
 * precisely why the two claims live in different fields.
 *
 * No ACHIEVABILITY check, and that is measured rather than assumed: every (set, class) pair covers
 * all 5 armour slots (168/168 on manifest 244213.26.06.29.2000-1-bnet.65583), so a targeted set is
 * always obtainable by any class. A rule here could never fire.
 */
const targetedSetBonusPlan: Rule = (build, lookup) => {
  const targets = build.armor.targetedSetBonuses ?? [];
  const out: Violation[] = [];
  const seen = new Set<Hash>();
  let pieces = 0;

  for (const t of targets) {
    if (lookup.armorSet(t.setHash) === undefined) {
      out.push({
        code: "SET_TARGET_INVALID",
        category: "game",
        message: `Targeted set ${t.setHash} is not in the dataset.`,
        subject: { kind: "armorSet", hash: t.setHash },
      });
    }
    if (t.pieceCount !== 2 && t.pieceCount !== 4) {
      out.push({
        code: "SET_TARGET_INVALID",
        category: "game",
        message: `A set bonus activates at 2 or 4 pieces, not ${t.pieceCount}.`,
        subject: { kind: "armorSet", hash: t.setHash },
      });
    }
    if (seen.has(t.setHash)) {
      out.push({
        code: "SET_TARGET_INVALID",
        category: "game",
        // Cumulative thresholds are WHY one entry per set suffices: targeting 4 already
        // activates the 2-piece bonus, so a second entry is a contradiction, not a refinement.
        message: `Set ${t.setHash} is targeted more than once; thresholds are cumulative, so `
          + "one entry per set is both sufficient and required.",
        subject: { kind: "armorSet", hash: t.setHash },
      });
    }
    seen.add(t.setHash);
    pieces += t.pieceCount;
  }

  if (pieces > SET_PIECE_BUDGET) {
    out.push({
      code: "SET_TARGET_INVALID",
      category: "game",
      message: `The targeted set bonuses need ${pieces} legendary pieces but only `
        + `${SET_PIECE_BUDGET} are available (5 armour slots minus the exotic).`,
    });
  }
  return out;
};
```

Add `SET_PIECE_BUDGET` and the `Hash` type to the file's imports from `@/lib/types`, and register the
rule in `armorRules`:

```typescript
export const armorRules: Rule[] = [
  exoticCount,
  classConsistency,
  slotUniqueness,
  setBonusCounts,
  targetedSetBonusPlan,
];
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `npx vitest run tests/validation/armor.test.ts && npx tsc --noEmit`
Expected: all PASS, `tsc` clean.

- [ ] **Step 7: Prove the budget check is load-bearing, by mutation**

```bash
python3 - <<'PY'
p="src/lib/validation/armor.ts"
s=open(p).read()
old="  if (pieces > SET_PIECE_BUDGET) {"
assert s.count(old)==1, f"target count {s.count(old)}"
open(p,"w").write(s.replace(old,"  if (false) { // MUTATION"))
PY
grep -n "MUTATION" src/lib/validation/armor.ts   # MUST print a line
npx vitest run tests/validation/armor.test.ts    # "rejects a plan needing more than 4 pieces" MUST fail
```

Then revert and confirm:

```bash
python3 - <<'PY'
p="src/lib/validation/armor.ts"
s=open(p).read()
old="  if (false) { // MUTATION"
assert s.count(old)==1
open(p,"w").write(s.replace(old,"  if (pieces > SET_PIECE_BUDGET) {"))
PY
grep -c MUTATION src/lib/validation/armor.ts     # MUST print 0
npx vitest run tests/validation/armor.test.ts    # green again
```

- [ ] **Step 8: Run the full suite and commit**

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`
Expected: 431 passing (424 + 7), 53 files, 0 failing. `tsc` and `eslint` clean.

```bash
git add src/lib/types/build.ts src/lib/validation/types.ts src/lib/validation/armor.ts tests/validation/armor.test.ts
git commit -m "feat(validation): add targetedSetBonuses + the SET_TARGET_INVALID rule

The solver never writes armor.pieces, so a prescribed bonus written to
armor.setBonuses emits SET_COUNT_INVALID on every solver-produced build.
Split the claim instead of weakening the rule: setBonuses stays ACTIVE
(counted from pieces), targetedSetBonuses is a GOAL (checkable without them).

setBonusCounts is deliberately untouched. The new rule checks only internal
legality - set resolves, threshold in {2,4}, one entry per set because
thresholds are cumulative, and total pieces <= 4.

No achievability rule, measured rather than assumed: every (set, class) pair
covers all 5 slots (168/168), so it could never fire.

SET_PIECE_BUDGET lives in types/build.ts rather than the solver module as the
spec said, because validation needs it and must not import the solver."
```

---

### Task 2: The solver module — pool, reach, budget

**Files:**
- Create: `src/lib/solver/set-bonuses.ts`
- Test: `tests/solver/set-bonuses.test.ts`

**Interfaces:**
- Consumes: `TargetedSetBonus`, `SET_PIECE_BUDGET` from `@/lib/types` (Task 1).
- Produces: `SetBonusOption { target: TargetedSetBonus; element: BuildElement }`,
  `deriveSetBonusPool(ctx: SolverContext): SetBonusOption[]`,
  `deriveSetBonusReach(ctx: SolverContext, targets: readonly TargetedSetBonus[]): BuildElement[]`,
  `remainingPieceBudget(targets: readonly TargetedSetBonus[]): number`. Task 4 imports all four.

**Why the pool carries a precomputed `element` rather than returning bare targets:**
`generateCandidates` (Task 4) has no `Lookup` — every candidate's `element` is resolved by the env
before it gets there. Carrying it on the pool entry is how a `setBonus` candidate gets an element
without widening `CandidateEnv` with a lookup. `deriveSetBonusReach` deliberately takes bare
**targets**, not options, so it is callable from a test without fabricating an element.

- [ ] **Step 1: Write the failing tests**

Create `tests/solver/set-bonuses.test.ts`:

```typescript
import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import { createLookup } from "@/lib/validation";
import type { ArmorSet, DerivedDataset } from "@/lib/types";
import { EMPTY_TAGS, SET_PIECE_BUDGET } from "@/lib/types";

import {
  deriveSetBonusPool, deriveSetBonusReach, remainingPieceBudget,
} from "@/lib/solver/set-bonuses";

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));
const tag = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });

/** A set whose 2-piece bonus is tagged and whose 4-piece bonus is NOT. */
const setOnly2: ArmorSet = {
  kind: "armorSet", hash: 900, name: "Only2", setItemHashes: [],
  bonuses: [
    { requiredCount: 2, sandboxPerkHash: 9001, name: "Two", description: "", tags: tag({ produces: ["jolt"] }) },
    { requiredCount: 4, sandboxPerkHash: 9002, name: "Four", description: "", tags: EMPTY_TAGS },
  ],
} as ArmorSet;
/** A set whose 4-piece bonus is tagged and whose 2-piece bonus is NOT. */
const setOnly4: ArmorSet = {
  kind: "armorSet", hash: 901, name: "Only4", setItemHashes: [],
  bonuses: [
    { requiredCount: 2, sandboxPerkHash: 9011, name: "Two", description: "", tags: EMPTY_TAGS },
    { requiredCount: 4, sandboxPerkHash: 9012, name: "Four", description: "", tags: tag({ produces: ["blind"] }) },
  ],
} as ArmorSet;
/** Both tagged ⇒ contributes TWO options. */
const setBoth: ArmorSet = {
  kind: "armorSet", hash: 902, name: "Both", setItemHashes: [],
  bonuses: [
    { requiredCount: 2, sandboxPerkHash: 9021, name: "Two", description: "", tags: tag({ produces: ["scorch"] }) },
    { requiredCount: 4, sandboxPerkHash: 9022, name: "Four", description: "", tags: tag({ consumes: ["scorch"] }) },
  ],
} as ArmorSet;
/** Neither tagged ⇒ contributes NOTHING. */
const setNeither: ArmorSet = {
  kind: "armorSet", hash: 903, name: "Neither", setItemHashes: [],
  bonuses: [
    { requiredCount: 2, sandboxPerkHash: 9031, name: "Two", description: "", tags: EMPTY_TAGS },
    { requiredCount: 4, sandboxPerkHash: 9032, name: "Four", description: "", tags: EMPTY_TAGS },
  ],
} as ArmorSet;

function ctxFor(armorSets: ArmorSet[]) {
  const ds = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [], fragments: [], weapons: [], armor: [], armorSets,
    mods: [], artifacts: [], perks: [], stats: [], plugTags: {}, socketTypes: {},
    indexes: {
      keyword: { producers: {}, consumers: {} },
      perkToWeapons: {}, elementToItems: {},
      // Enumeration source: the solver reaches sets through this index rather than by
      // walking the dataset array.
      setToPieces: Object.fromEntries(armorSets.map((s) => [s.hash, []])),
      exoticToClassSlot: {}, slotToWeapons: {},
    },
  } as unknown as DerivedDataset;
  return { lookup: createLookup(ds), indexes: ds.indexes };
}

describe("deriveSetBonusPool", () => {
  /** The decisions the pool offers, without the precomputed elements. */
  const targetsOf = (sets: ArmorSet[]) =>
    deriveSetBonusPool(ctxFor(sets)).map((o) => o.target);

  it("emits exactly one option per TAGGED bonus", () => {
    expect(targetsOf([setOnly2, setOnly4, setBoth, setNeither])).toEqual([
      { setHash: 900, pieceCount: 2 },
      { setHash: 901, pieceCount: 4 },
      { setHash: 902, pieceCount: 2 },
      { setHash: 902, pieceCount: 4 },
    ]);
  });

  it("omits a 4-piece option when only the 2-piece bonus is tagged", () => {
    // Spending 4 pieces to activate exactly the tags 2 pieces already buy is strictly
    // dominated while there is no stat model. Revisit at SP4.
    expect(targetsOf([setOnly2])).toEqual([{ setHash: 900, pieceCount: 2 }]);
  });

  it("omits a 2-piece option when only the 4-piece bonus is tagged", () => {
    expect(targetsOf([setOnly4])).toEqual([{ setHash: 901, pieceCount: 4 }]);
  });

  it("excludes a set with no tagged bonus at all", () => {
    expect(targetsOf([setNeither])).toEqual([]);
  });

  it("sorts by (setHash, pieceCount) so the move order is deterministic", () => {
    expect(targetsOf([setBoth, setOnly2]).map((t) => `${t.setHash}x${t.pieceCount}`))
      .toEqual(["900x2", "902x2", "902x4"]);
  });

  it("carries the THRESHOLD bonus's element on each option", () => {
    // Candidates need an element and `generateCandidates` has no Lookup, so the pool carries it.
    const [option] = deriveSetBonusPool(ctxFor([setOnly2]));
    expect(option.element).toEqual({
      hash: 9001,
      source: "set-bonus:Two",
      tags: { ...EMPTY_TAGS, produces: ["jolt"] },
    });
  });
});

describe("deriveSetBonusReach", () => {
  it("includes the 2-piece bonus for a 4-piece option, because thresholds are cumulative", () => {
    const ctx = ctxFor([setBoth]);
    const reach = deriveSetBonusReach(ctx, [{ setHash: 902, pieceCount: 4 }]);
    expect(reach.map((e) => e.hash).sort((a, b) => a - b)).toEqual([9021, 9022]);
  });

  it("includes only the 2-piece bonus for a 2-piece option", () => {
    const ctx = ctxFor([setBoth]);
    const reach = deriveSetBonusReach(ctx, [{ setHash: 902, pieceCount: 2 }]);
    expect(reach.map((e) => e.hash)).toEqual([9021]);
  });

  it("dedups by sandbox perk hash across overlapping options", () => {
    // (902,2) and (902,4) both activate 9021. It must appear ONCE, or the bound
    // double-counts one producer.
    const ctx = ctxFor([setBoth]);
    const reach = deriveSetBonusReach(ctx, deriveSetBonusPool(ctx).map((o) => o.target));
    expect(reach.filter((e) => e.hash === 9021)).toHaveLength(1);
    expect(reach).toHaveLength(2);
  });

  it("omits untagged bonuses, which cannot move the bound", () => {
    const ctx = ctxFor([setOnly2]);
    const reach = deriveSetBonusReach(ctx, [{ setHash: 900, pieceCount: 4 }]);
    expect(reach.map((e) => e.hash)).toEqual([9001]); // 9002 is untagged
  });

  it("carries the BONUS's own tags and a set-bonus source label", () => {
    const ctx = ctxFor([setOnly2]);
    const [element] = deriveSetBonusReach(ctx, [{ setHash: 900, pieceCount: 2 }]);
    expect(element.source).toBe("set-bonus:Two");
    expect(element.tags.produces).toEqual(["jolt"]);
  });
});

describe("remainingPieceBudget", () => {
  it("starts at the full budget and spends down", () => {
    expect(remainingPieceBudget([])).toBe(SET_PIECE_BUDGET);
    expect(remainingPieceBudget([{ setHash: 1, pieceCount: 2 }])).toBe(2);
    expect(remainingPieceBudget([{ setHash: 1, pieceCount: 4 }])).toBe(0);
    expect(remainingPieceBudget([
      { setHash: 1, pieceCount: 2 }, { setHash: 2, pieceCount: 2 },
    ])).toBe(0);
  });
});

describe.runIf(hasDataset)("deriveSetBonusPool — against the real dataset", () => {
  it("bounds the pool on BOTH sides, so over-inclusion fails too", async () => {
    const dataset = await loadDataset();
    const pool = deriveSetBonusPool({ lookup: createLookup(dataset), indexes: dataset.indexes });
    // Measured 58 (29 two-piece + 29 four-piece tagged bonuses across 56 sets). Bounded rather
    // than pinned exactly so season drift does not fail the suite, but bounded on both sides so
    // admitting untagged bonuses — which would roughly double it to ~112 — fails loudly.
    expect(pool.length).toBeGreaterThanOrEqual(40);
    expect(pool.length).toBeLessThan(80);
    // Every option is a legal threshold, and no set appears at the same threshold twice.
    const keys = pool.map((o) => `${o.target.setHash}x${o.target.pieceCount}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const o of pool) expect([2, 4]).toContain(o.target.pieceCount);
    // Every option carries a tagged element — an untagged one could not move the bound.
    for (const o of pool) {
      const t = o.element.tags;
      expect(t.produces.length + t.consumes.length + t.triggers.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run tests/solver/set-bonuses.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/solver/set-bonuses"`.

- [ ] **Step 3: Implement the module**

Create `src/lib/solver/set-bonuses.ts`:

```typescript
import type { ArmorSetBonus, Hash, KeywordTags, TargetedSetBonus } from "@/lib/types";
import { SET_PIECE_BUDGET } from "@/lib/types";

import type { BuildElement } from "@/lib/synergy";

import type { SolverContext } from "./types";

/**
 * Tag richness — counts ONLY the three chain fields `scoreSynergy`/`synergyUpperBound` read.
 * `championStuns` is deliberately excluded: it is coverage-only, so counting it would admit
 * scoring-inert bonuses into the pool and the reach union for nothing. Same rule as `armor.ts`'s
 * and `subclass.ts`'s `tagSize`; do not "fix" any of them by adding it.
 */
const tagSize = (tags: KeywordTags) =>
  tags.produces.length + tags.consumes.length + tags.triggers.length;

/** Bonuses a target activates. CUMULATIVE: 4 pieces fire the 2-piece bonus as well. */
function activatedBonuses(ctx: SolverContext, target: TargetedSetBonus): ArmorSetBonus[] {
  const set = ctx.lookup.armorSet(target.setHash);
  if (!set) return [];
  return set.bonuses.filter((b) => b.requiredCount <= target.pieceCount);
}

/**
 * A pool entry: the decision, plus the element its THRESHOLD bonus contributes.
 *
 * The element is precomputed here because `generateCandidates` has no `Lookup` with which to
 * resolve one, and every candidate needs an `element`. It is only ever a diagnostic label:
 * `setBonus` candidates are filtered OUT of the bound's `addable` set (see `makeState`), because
 * `deriveSetBonusReach` covers the whole dimension — the same treatment weapon, exotic, aspect and
 * mod moves get.
 */
export interface SetBonusOption {
  target: TargetedSetBonus;
  element: BuildElement;
}

/**
 * Every (set, threshold) worth targeting — exactly ONE option per TAGGED bonus.
 *
 * Measured 58 on manifest 244213.26.06.29.2000-1-bnet.65583: 29 tagged 2-piece + 29 tagged
 * 4-piece, across 56 sets that each carry exactly one bonus at each threshold.
 *
 * Two exclusions, both sound only because there is NO STAT MODEL yet — revisit both at SP4:
 * 1. An UNTAGGED bonus is omitted entirely. Unlike an aspect (which grants fragment slots) or a
 *    weapon (which fills a required slot), an untagged set bonus can do nothing at all, so
 *    admitting it would only breed identical-scoring states.
 * 2. `(S,4)` is omitted when only S's 2-PIECE bonus is tagged: spending 4 pieces to activate
 *    exactly the tags 2 pieces already buy is strictly dominated.
 *
 * Sets are enumerated through `indexes.setToPieces`, whose keys are the set hashes, so the solver
 * still never walks a dataset array.
 *
 * ⚠️ The pool is CLASS-INDEPENDENT, unlike every other pool in the solver — all 56 sets cover all
 * 3 classes, so there is nothing to filter on. Consequently nothing in a build naturally CLOSES
 * this dimension; it is gated by `SolveOptions.chooseSetBonuses` alone.
 */
export function deriveSetBonusPool(ctx: SolverContext): SetBonusOption[] {
  const out: SetBonusOption[] = [];
  for (const key of Object.keys(ctx.indexes.setToPieces)) {
    const setHash = Number(key);
    const set = ctx.lookup.armorSet(setHash);
    if (!set) continue;
    for (const bonus of set.bonuses) {
      if (bonus.requiredCount !== 2 && bonus.requiredCount !== 4) continue;
      if (tagSize(bonus.tags) === 0) continue;
      out.push({
        target: { setHash, pieceCount: bonus.requiredCount },
        element: {
          hash: bonus.sandboxPerkHash,
          source: `set-bonus:${bonus.name}`,
          tags: bonus.tags,
        },
      });
    }
  }
  return out.sort((a, b) =>
    a.target.setHash - b.target.setHash || a.target.pieceCount - b.target.pieceCount);
}

/**
 * Loose reachable-union for a still-undecided plan: every tagged bonus any pool option activates.
 *
 * A superset of what any completion contributes (a plan activates at most 2 bonuses), so it
 * over-credits only — which is what an admissible bound requires. Keyed and deduped by
 * `sandboxPerkHash`, which IS the synergy identity for a set bonus: all 112 are distinct and all
 * 112 resolve in `perks.json`, so no name bridging arises here (unlike weapon plugs). Without the
 * dedup, `(S,2)` and `(S,4)` would both contribute S's 2-piece bonus and the bound would
 * double-count one producer.
 *
 * ⚠️ DO NOT dedup by TAG SIGNATURE, the way slice 2c dedups `modReach`. At most two bonuses
 * activate, but two DIFFERENT sets can both produce the same keyword, so collapsing identical
 * signatures would UNDER-count producers and make the bound inadmissible — silently breaking the
 * pruning SP3a depends on. There is no cost pressure to justify it: this dimension is 2 levels
 * deep and <=58 wide.
 */
export function deriveSetBonusReach(
  ctx: SolverContext,
  targets: readonly TargetedSetBonus[],
): BuildElement[] {
  const out: BuildElement[] = [];
  const seen = new Set<Hash>();
  for (const target of targets) {
    for (const bonus of activatedBonuses(ctx, target)) {
      if (tagSize(bonus.tags) === 0) continue;
      if (seen.has(bonus.sandboxPerkHash)) continue;
      seen.add(bonus.sandboxPerkHash);
      out.push({
        hash: bonus.sandboxPerkHash,
        source: `set-bonus:${bonus.name}`,
        tags: bonus.tags,
      });
    }
  }
  return out;
}

/** Legendary piece slots still unspent by a plan. */
export function remainingPieceBudget(targets: readonly TargetedSetBonus[]): number {
  return SET_PIECE_BUDGET - targets.reduce((sum, t) => sum + t.pieceCount, 0);
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run tests/solver/set-bonuses.test.ts && npx tsc --noEmit`
Expected: all PASS. If the real-data test reports a pool size outside 40-80, STOP — the dataset
differs from what the spec measured; re-measure and reconcile before continuing.

- [ ] **Step 5: Prove the tagged-only filter and the cumulative reach are load-bearing**

Mutation A — admit untagged bonuses into the pool:

```bash
python3 - <<'PY'
p="src/lib/solver/set-bonuses.ts"
s=open(p).read()
old="      if (tagSize(bonus.tags) === 0) continue;\n      out.push({"
assert s.count(old)==1, f"target count {s.count(old)}"
open(p,"w").write(s.replace(old,"      // MUTATION\n      out.push({"))
PY
grep -n "MUTATION" src/lib/solver/set-bonuses.ts     # MUST print a line
npx vitest run tests/solver/set-bonuses.test.ts      # the 4 pool tests + real-data bound MUST fail
```

Revert, confirming with `grep -c MUTATION` → `0`, then Mutation B — break cumulative reach:

```bash
python3 - <<'PY'
p="src/lib/solver/set-bonuses.ts"
s=open(p).read()
old="  return set.bonuses.filter((b) => b.requiredCount <= target.pieceCount);"
assert s.count(old)==1
open(p,"w").write(s.replace(old,"  return set.bonuses.filter((b) => b.requiredCount === target.pieceCount); // MUTATION"))
PY
grep -n "MUTATION" src/lib/solver/set-bonuses.ts     # MUST print a line
npx vitest run tests/solver/set-bonuses.test.ts      # the cumulative reach tests MUST fail
```

Revert and confirm `grep -c MUTATION` → `0`, then re-run the file green.

- [ ] **Step 6: Run the full suite and commit**

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`
Expected: 448 passing (431 + 17), 53 files → 54 files, 0 failing.

```bash
git add src/lib/solver/set-bonuses.ts tests/solver/set-bonuses.test.ts
git commit -m "feat(solver): derive the set-bonus pool, reach and piece budget

One option per TAGGED bonus - measured 58 (29 two-piece + 29 four-piece over 56
sets, each carrying exactly one bonus per threshold). Sets are enumerated via
indexes.setToPieces so the solver still never walks a dataset array.

Two exclusions, sound only because there is no stat model, both flagged for SP4:
untagged bonuses (they can do nothing, so they only breed identical-scoring
states) and (S,4) where only S's 2-piece bonus is tagged (strictly dominated).

Reach is the full tagged union deduped by sandboxPerkHash - a superset of any
completion, hence admissible. Records why tag-signature dedup (slice 2c's mod
optimisation) is UNSOUND here: two different sets can produce the same keyword,
so collapsing signatures would under-count producers.

Pool bounded on both sides in tests so over-inclusion fails too. Mutation-proven
twice: admitting untagged bonuses reddens 5, and making activation
non-cumulative reddens the reach tests."
```

---

### Task 3: Cumulative activation in the synergy engine

**Files:**
- Modify: `src/lib/synergy/elements.ts` (in `collectBuildElements`, after the `armor.modHashes` loop)
- Test: `tests/synergy/elements-set-bonuses.test.ts`

**Interfaces:**
- Consumes: `ArmorLoadout.targetedSetBonuses` (Task 1), `Lookup.armorSet`.
- Produces: `BuildElement`s with `source: "set-bonus:<name>"` keyed by `sandboxPerkHash`. Tasks 5 and
  7 rely on this being how a target earns score.

**Why this is its own task:** cumulative thresholds are a user-confirmed GAME MECHANIC, not a
manifest fact. It earns a direct test rather than being implied by integration results.

- [ ] **Step 1: Write the failing test**

Create `tests/synergy/elements-set-bonuses.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import type { ArmorSet, Build, DerivedDataset } from "@/lib/types";
import { EMPTY_TAGS } from "@/lib/types";

import { collectBuildElements } from "@/lib/synergy/elements";

const tag = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });

const set902: ArmorSet = {
  kind: "armorSet", hash: 902, name: "Both", setItemHashes: [],
  bonuses: [
    { requiredCount: 2, sandboxPerkHash: 9021, name: "TwoPc", description: "", tags: tag({ produces: ["scorch"] }) },
    { requiredCount: 4, sandboxPerkHash: 9022, name: "FourPc", description: "", tags: tag({ consumes: ["scorch"] }) },
  ],
} as ArmorSet;

function lookupFor() {
  const ds = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [], fragments: [], weapons: [], armor: [], armorSets: [set902],
    mods: [], artifacts: [], perks: [], stats: [], plugTags: {}, socketTypes: {},
    indexes: {
      keyword: { producers: {}, consumers: {} },
      perkToWeapons: {}, elementToItems: {}, setToPieces: { 902: [] },
      exoticToClassSlot: {}, slotToWeapons: {},
    },
  } as unknown as DerivedDataset;
  return createLookup(ds);
}

const buildWith = (targetedSetBonuses: { setHash: number; pieceCount: number }[]): Build => ({
  subclass: { element: "solar", aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [], targetedSetBonuses },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
}) as unknown as Build;

describe("collectBuildElements — targeted set bonuses", () => {
  it("yields TWO elements for a 4-piece target, because thresholds are cumulative", () => {
    // The mechanic, confirmed with the user 2026-07-29: wearing 4 pieces fires the set's
    // 2-piece bonus as well as its 4-piece bonus.
    const els = collectBuildElements(buildWith([{ setHash: 902, pieceCount: 4 }]), lookupFor());
    expect(els.map((e) => e.hash).sort((a, b) => a - b)).toEqual([9021, 9022]);
    expect(els.map((e) => e.source).sort())
      .toEqual(["set-bonus:FourPc", "set-bonus:TwoPc"]);
  });

  it("yields ONE element for a 2-piece target", () => {
    const els = collectBuildElements(buildWith([{ setHash: 902, pieceCount: 2 }]), lookupFor());
    expect(els.map((e) => e.hash)).toEqual([9021]);
    expect(els[0].tags.produces).toEqual(["scorch"]);
  });

  it("yields nothing when no set bonus is targeted", () => {
    expect(collectBuildElements(buildWith([]), lookupFor())).toEqual([]);
  });

  it("is inert when the field is absent, so no pre-existing build changes score", () => {
    const build = buildWith([]);
    delete (build.armor as { targetedSetBonuses?: unknown }).targetedSetBonuses;
    expect(collectBuildElements(build, lookupFor())).toEqual([]);
  });

  it("ignores a set hash that does not resolve, rather than throwing", () => {
    // Consistent with every other family in this function: unresolvable hashes are skipped
    // here, because synergy scoring must not crash on a build the validator will reject.
    expect(collectBuildElements(buildWith([{ setHash: 4242, pieceCount: 2 }]), lookupFor()))
      .toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/synergy/elements-set-bonuses.test.ts`
Expected: the first two tests FAIL (`[]` received, `[9021, 9022]` expected). The three inert/skip
tests already PASS — regression guards, as in Task 1.

- [ ] **Step 3: Implement**

In `src/lib/synergy/elements.ts`, add immediately after the `for (const h of build.armor.modHashes)`
loop and before the `build.artifact.selectedPerkHashes` loop:

```typescript
  for (const t of build.armor.targetedSetBonuses ?? []) {
    const set = lookup.armorSet(t.setHash);
    if (!set) continue;
    for (const b of set.bonuses) {
      // CUMULATIVE thresholds (user-confirmed 2026-07-29): 4 pieces fire the 2-piece bonus
      // too, so a 4-piece target contributes TWO elements. `<=`, not `===`.
      //
      // Keyed by sandboxPerkHash — the synergy identity for a set bonus, all 112 distinct and
      // all resolving in perks.json — with the BONUS's own tags rather than the resolved
      // sandbox perk's, because the ingest tags each bonus individually.
      if (b.requiredCount <= t.pieceCount) add(b.sandboxPerkHash, `set-bonus:${b.name}`, b.tags);
    }
  }
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run tests/synergy/elements-set-bonuses.test.ts && npx tsc --noEmit`
Expected: all 5 PASS.

- [ ] **Step 5: Prove cumulative activation is load-bearing, by mutation**

```bash
python3 - <<'PY'
p="src/lib/synergy/elements.ts"
s=open(p).read()
old="      if (b.requiredCount <= t.pieceCount) add(b.sandboxPerkHash, `set-bonus:${b.name}`, b.tags);"
assert s.count(old)==1, f"target count {s.count(old)}"
open(p,"w").write(s.replace(old,"      if (b.requiredCount === t.pieceCount) add(b.sandboxPerkHash, `set-bonus:${b.name}`, b.tags); // MUTATION"))
PY
grep -n "MUTATION" src/lib/synergy/elements.ts   # MUST print a line
npx vitest run tests/synergy/elements-set-bonuses.test.ts  # the 4-piece test MUST fail
```

Revert with the inverse replacement and confirm `grep -c MUTATION src/lib/synergy/elements.ts` → `0`.

- [ ] **Step 6: Run the full suite and commit**

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`
Expected: 453 passing (448 + 5), 55 files, 0 failing. **No existing synergy test may change** — the
`?? []` keeps every pre-existing build inert.

```bash
git add src/lib/synergy/elements.ts tests/synergy/elements-set-bonuses.test.ts
git commit -m "feat(synergy): targeted set bonuses become build elements, cumulatively

Thresholds are CUMULATIVE (user-confirmed 2026-07-29), so a 4-piece target
contributes TWO elements: the set's 2-piece bonus fires as well. The filter is
requiredCount <= pieceCount, and using === instead reddens the 4-piece test
(mutation-proven).

Keyed by sandboxPerkHash - the synergy identity for a set bonus, all 112
distinct and all resolving in perks.json - carrying the BONUS's own ingested
tags rather than the resolved sandbox perk's.

Inert via ?? [] when the field is absent, so no pre-existing build changes score."
```

---

### Task 4: Beam wiring — option, env, Selection, candidates, expand, key

**Files:**
- Modify: `src/lib/solver/types.ts` (`SolveOptions`, after `chooseMods` at line 46)
- Modify: `src/lib/solver/candidates.ts` (`Candidate` at lines 58-75, `CandidateEnv` at 92+, `generateCandidates` at 128+)
- Modify: `src/lib/solver/beam.ts` (`SolverEnv` 34-83, `Selection` 98-119, `stateKey` 134-159, `resolveSolverEnv`, `makeState` 406+, `expand`, `dimensionsAllDecided` 550+)
- Modify: every test file `tsc` names in Step 3 (expected: `tests/solver/beam-aspects.test.ts`, `beam-exotic-wiring.test.ts`, `beam-exotic.test.ts`, `beam-mods.test.ts` — 25 call sites total)
- Test: `tests/solver/beam-set-bonuses.test.ts`

**Interfaces:**
- Consumes: `deriveSetBonusPool`, `deriveSetBonusReach`, `remainingPieceBudget` (Task 2); cumulative
  scoring (Task 3).
- Produces: `SolveOptions.chooseSetBonuses?: boolean` (default **false** — Task 7 decides the final
  default); `SolverEnv.setBonusPool?: TargetedSetBonus[]` and `SolverEnv.setBonusReach?: BuildElement[]`;
  `Selection.setBonusTargets: TargetedSetBonus[]` (**required**); `Candidate.kind` gains `"setBonus"`
  and `Candidate.pieceCount?: number`; `stateKey` gains a trailing `|set:` segment.

- [ ] **Step 1: Write the failing tests**

Create `tests/solver/beam-set-bonuses.test.ts`. (The admissibility gate is added to this same file in
Task 5; this task covers serialisation, opt-in wiring and budget gating.)

```typescript
import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import type { Armor, ArmorSet, Artifact, Aspect, Build, DerivedDataset, Fragment } from "@/lib/types";
import { EMPTY_TAGS } from "@/lib/types";
import { synergyUpperBound } from "@/lib/synergy";

import { buildSolverEnv, makeState, stateKey } from "@/lib/solver/beam";

const tag = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });

const TIERING_SOCKET = 8800;
const SOCKET_TYPES = { [TIERING_SOCKET]: ["core.gear_systems.armor_tiering.plugs.tuning.mods"] };

/** One fragment slot, so the consumer fragment can be pinned and that dimension then closes. */
const aspectSlot: Aspect = {
  kind: "aspect", hash: 100, name: "AspSlot", element: "arc", classType: "any",
  fragmentSlots: 1, tags: EMPTY_TAGS,
} as Aspect;
/** Second aspect, purely to reach ASPECT_CAP so that dimension is closed. */
const aspectFiller: Aspect = {
  kind: "aspect", hash: 199, name: "Filler", element: "arc", classType: "any",
  fragmentSlots: 0, tags: EMPTY_TAGS,
} as Aspect;
const artifact300: Artifact = {
  kind: "artifact", hash: 300, name: "Art", tiers: [{ tierIndex: 0, slots: 0, perks: [] }],
} as Artifact;
/** The CONSUMER, pinned into the build, so a producer is worth points. */
const fragConsumer: Fragment = {
  kind: "fragment", hash: 500, name: "FragCons", element: "arc",
  statModifiers: [], tags: tag({ consumes: ["jolt"] }),
} as Fragment;
/** Pinned via armor.exoticHash, which CLOSES the exotic dimension. */
const exotic: Armor = {
  kind: "armor", hash: 9000, name: "Exo", icon: "", slot: "helmet", tier: "exotic",
  classType: "warlock", modSocketHashes: [TIERING_SOCKET], tags: EMPTY_TAGS,
} as Armor;
/** The ONLY producer of "jolt" in this fixture is a SET BONUS. Its 4-piece bonus is untagged. */
const setProducer: ArmorSet = {
  kind: "armorSet", hash: 902, name: "Producer", setItemHashes: [],
  bonuses: [
    { requiredCount: 2, sandboxPerkHash: 9021, name: "ProdTwo", description: "", tags: tag({ produces: ["jolt"] }) },
    { requiredCount: 4, sandboxPerkHash: 9022, name: "InertFour", description: "", tags: EMPTY_TAGS },
  ],
} as ArmorSet;
/** A second tagged set, so two-2-piece plans exist and budget gating is observable. */
const setSecond: ArmorSet = {
  kind: "armorSet", hash: 903, name: "Second", setItemHashes: [],
  bonuses: [
    { requiredCount: 2, sandboxPerkHash: 9031, name: "SecTwo", description: "", tags: tag({ produces: ["blind"] }) },
    { requiredCount: 4, sandboxPerkHash: 9032, name: "SecFour", description: "", tags: tag({ produces: ["blind"] }) },
  ],
} as ArmorSet;

export function ctxFor() {
  const ds = {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [aspectSlot, aspectFiller], fragments: [fragConsumer],
    weapons: [], armor: [exotic], armorSets: [setProducer, setSecond], mods: [],
    artifacts: [artifact300], perks: [], stats: [], plugTags: {}, socketTypes: SOCKET_TYPES,
    indexes: {
      keyword: { producers: {}, consumers: {} },
      perkToWeapons: {}, elementToItems: { arc: [fragConsumer.hash] },
      setToPieces: { 902: [], 903: [] },
      exoticToClassSlot: { [exotic.hash]: { classType: "warlock", slot: "helmet" } },
      slotToWeapons: {},
    },
  } as unknown as DerivedDataset;
  return { lookup: createLookup(ds), indexes: ds.indexes };
}

/** Every other dimension CLOSED, so set bonuses are the only open one. */
export const base = (): Build => ({
  subclass: {
    element: "arc", classType: "warlock",
    aspectHashes: [aspectSlot.hash, aspectFiller.hash], fragmentHashes: [],
  },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [], exoticHash: exotic.hash },
  artifact: { artifactHash: 300, selectedPerkHashes: [] },
  constraints: [],
}) as unknown as Build;

describe("stateKey — set-bonus component", () => {
  const sel = (setBonusTargets: { setHash: number; pieceCount: number }[]) =>
    ({ fragHashes: [1], perkHashes: [2], weapons: [], aspectHashes: [], mods: [], setBonusTargets });

  it("appends nothing when no set bonus is targeted", () => {
    // Byte-compatibility: every key written before this dimension existed must be unchanged.
    expect(stateKey(sel([]))).toBe("frag:1|perk:2");
  });

  it("serialises set and threshold, sorted so choice order is not identity", () => {
    const a = stateKey(sel([{ setHash: 903, pieceCount: 2 }, { setHash: 902, pieceCount: 2 }]));
    const b = stateKey(sel([{ setHash: 902, pieceCount: 2 }, { setHash: 903, pieceCount: 2 }]));
    expect(a).toBe(b);
    expect(a).toBe("frag:1|perk:2|set:902x2;903x2");
  });

  it("distinguishes thresholds on the same set", () => {
    expect(stateKey(sel([{ setHash: 902, pieceCount: 2 }])))
      .not.toBe(stateKey(sel([{ setHash: 902, pieceCount: 4 }])));
  });
});

describe("buildSolverEnv — the set-bonus dimension is opt-in", () => {
  it("stays CLOSED without the option", () => {
    const env = buildSolverEnv(base(), ctxFor(), {})!;
    expect(env.setBonusPool).toBeUndefined();
  });

  it("OPENS with chooseSetBonuses, and the pool is tagged-only", () => {
    const env = buildSolverEnv(base(), ctxFor(), { chooseSetBonuses: true })!;
    // 902's 4-piece bonus is untagged ⇒ no (902,4) option. 903 is tagged at both.
    expect(env.setBonusPool?.map((t) => `${t.setHash}x${t.pieceCount}`))
      .toEqual(["902x2", "903x2", "903x4"]);
  });
});

describe("generateCandidates — set-bonus moves respect the piece budget", () => {
  const stateFor = (targets: { setHash: number; pieceCount: number }[]) => {
    const env = buildSolverEnv(base(), ctxFor(), { chooseSetBonuses: true })!;
    return makeState(env, {
      fragHashes: [fragConsumer.hash], perkHashes: [], weapons: [], aspectHashes: [], mods: [],
      setBonusTargets: targets,
    }, synergyUpperBound);
  };
  const moves = (targets: { setHash: number; pieceCount: number }[]) =>
    stateFor(targets).candidates.filter((c) => c.kind === "setBonus")
      .map((c) => `${c.hash}x${c.pieceCount}`).sort();

  it("offers every pool option from an empty plan", () => {
    expect(moves([])).toEqual(["902x2", "903x2", "903x4"]);
  });

  it("offers only affordable 2-piece options on OTHER sets after one 2-piece target", () => {
    // Budget 2 remains, so 903x4 is unaffordable; 902 is already targeted, and thresholds are
    // cumulative so a second entry on it would be a contradiction.
    expect(moves([{ setHash: 902, pieceCount: 2 }])).toEqual(["903x2"]);
  });

  it("offers nothing once the budget is spent by a 4-piece target", () => {
    expect(moves([{ setHash: 903, pieceCount: 4 }])).toEqual([]);
  });

  it("offers nothing once two 2-piece targets are taken", () => {
    expect(moves([
      { setHash: 902, pieceCount: 2 }, { setHash: 903, pieceCount: 2 },
    ])).toEqual([]);
  });

  it("writes the targets onto the build, so scoring and validation can see them", () => {
    const state = stateFor([{ setHash: 902, pieceCount: 2 }]);
    expect(state.build.armor.targetedSetBonuses).toEqual([{ setHash: 902, pieceCount: 2 }]);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run tests/solver/beam-set-bonuses.test.ts`
Expected: FAIL — `chooseSetBonuses` is not a known option and `setBonusTargets` is not on
`Selection`, so most tests fail on type/shape. This is the correct failure.

- [ ] **Step 3: Add the option, the Selection field, and let `tsc` enumerate the call sites**

In `src/lib/solver/types.ts`, add to `SolveOptions` after `chooseMods`:

```typescript
  /**
   * Open the solver-chosen SET-BONUS dimension. Default **false**.
   *
   * Opt-in for the same byte-compatibility reason as `chooseMods`, and one that bites harder: the
   * set-bonus pool is CLASS-INDEPENDENT (all 56 sets cover all 3 classes), so unlike exotics and
   * aspects nothing in a build ever closes it naturally. Defaulting to on would change the output
   * of every existing solve.
   */
  chooseSetBonuses?: boolean;
```

In `src/lib/solver/beam.ts`, add to `Selection` after `mods`:

```typescript
  /**
   * Set bonuses this state TARGETS, each a (set, threshold) pair. REQUIRED rather than optional:
   * this is where forwarding bugs live, and the `Selection` refactor exists precisely so that
   * dropping a dimension has to be written deliberately. Empty when the dimension is closed,
   * which keeps state keys byte-identical to every key written before it existed.
   */
  setBonusTargets: TargetedSetBonus[];
```

Now run `npx tsc --noEmit`. It will name **every** `Selection` literal missing the field — expected
25 call sites across `tests/solver/beam-aspects.test.ts`, `beam-exotic-wiring.test.ts`,
`beam-exotic.test.ts` and `beam-mods.test.ts`. Add `setBonusTargets: []` to each. **Let `tsc` drive
this — do not grep-and-replace.** Re-run until clean; that is the checklist.

- [ ] **Step 4: Add the candidate kind**

In `src/lib/solver/candidates.ts`, extend `Candidate`:

```typescript
  kind: "fragment" | "artifactPerk" | "weapon" | "weaponPerk" | "exoticArmor" | "aspect" | "mod"
    | "setBonus";
```

and add the field after `column`:

```typescript
  /**
   * Pieces the target requires (2 or 4) — present only for "setBonus" moves, where `hash` is the
   * SET hash. Both halves are needed because the threshold, not just the set, is the decision.
   */
  pieceCount?: number;
```

Extend `CandidateEnv` after `modCapacity`:

```typescript
  /**
   * Every (set, threshold) worth targeting, each carrying the element its THRESHOLD bonus
   * contributes. ABSENT ⇒ the dimension is CLOSED (opt-in via `SolveOptions.chooseSetBonuses`).
   * Optional so envs predating this dimension still type-check.
   *
   * The element is precomputed by `deriveSetBonusPool` rather than resolved here, because this
   * function has no `Lookup`.
   */
  setBonusPool?: SetBonusOption[];
```

Add a trailing default parameter to `generateCandidates` — trailing, so the existing positional call
sites in tests keep working:

```typescript
  setBonusTargets: TargetedSetBonus[] = [],
```

and emit the moves, after the mod block and before the weapon block:

```typescript
  // Set bonuses: one move per affordable pool option on a set not already targeted. Optional and
  // budget-bounded, so underfill is legal and a state with no affordable option is MAXIMAL rather
  // than incomplete — see `dimensionsAllDecided`.
  if (env.setBonusPool !== undefined) {
    const budget = remainingPieceBudget(setBonusTargets);
    const targetedSets = new Set(setBonusTargets.map((t) => t.setHash));
    for (const option of env.setBonusPool) {
      if (option.target.pieceCount > budget) continue;
      // Thresholds are CUMULATIVE, so a second entry on an already-targeted set is a
      // contradiction rather than a refinement.
      if (targetedSets.has(option.target.setHash)) continue;
      out.push({
        kind: "setBonus", hash: option.target.setHash, pieceCount: option.target.pieceCount,
        element: option.element,
      });
    }
  }
```

Import `remainingPieceBudget` and `type SetBonusOption` from `./set-bonuses`, and
`type TargetedSetBonus` from `@/lib/types`, into `candidates.ts`.

- [ ] **Step 5: Wire the env**

In `src/lib/solver/beam.ts`, add to `SolverEnv` after the mod fields:

```typescript
  /**
   * Every (set, threshold) worth targeting. `undefined` ⇒ the set-bonus dimension is CLOSED,
   * which is the default; it opens only via `SolveOptions.chooseSetBonuses`, because the pool is
   * class-independent and so nothing in a build ever closes it naturally.
   */
  setBonusPool?: SetBonusOption[];
  /** Loose reachable-union for a still-unfinished plan (open-slot bound). */
  setBonusReach?: BuildElement[];
```

In `resolveSolverEnv`, after the mod block and before the `if (reasons.length > 0 …)` guard:

```typescript
  // Set bonuses. Opt-in for the same reason as mods, only more sharply: the pool is
  // class-independent, so unlike exotics and aspects nothing in a build ever closes this
  // dimension and defaulting to on would change every existing solve.
  let setBonusSurfaces: {
    setBonusPool?: SetBonusOption[];
    setBonusReach?: BuildElement[];
  } = {};
  if (options.chooseSetBonuses === true) {
    const setBonusPool = deriveSetBonusPool(ctx);
    if (setBonusPool.length > 0) {
      setBonusSurfaces = { setBonusPool, setBonusReach: deriveSetBonusReach(ctx, setBonusPool) };
    }
  }
```

and spread `...setBonusSurfaces` into the returned env object, after `...modSurfaces`.

Add the import at the top of `beam.ts`:

```typescript
import { deriveSetBonusPool, deriveSetBonusReach, remainingPieceBudget, type SetBonusOption } from "./set-bonuses";
```

and `TargetedSetBonus` to the `@/lib/types` type import.

- [ ] **Step 6: Wire `stateKey`, `makeState` and `expand`**

`stateKey` — append LAST, after the mod segment, so every existing key is unchanged:

```typescript
  if (selection.setBonusTargets.length > 0) {
    // Sorted by (set, threshold) so choice order is not part of identity: {A,B} and {B,A} are
    // the same plan and must collapse to one state.
    const sets = [...selection.setBonusTargets]
      .sort((a, b) => a.setHash - b.setHash || a.pieceCount - b.pieceCount)
      .map((t) => `${t.setHash}x${t.pieceCount}`)
      .join(";");
    key = `${key}|set:${sets}`;
  }
```

`makeState` — normalise, write the build, pass to candidates, push the reach. After the `modPicks`
sort:

```typescript
  const setBonusTargets = [...selection.setBonusTargets]
    .sort((a, b) => a.setHash - b.setHash || a.pieceCount - b.pieceCount);
```

Add `setBonusTargets` to the `normalized` object. In the `armor:` block of `build`, after
`modHashes`:

```typescript
      // Base-pinned targets are kept and the solver's own appended, mirroring mods. Left
      // undefined when nothing is targeted, so pre-existing builds are byte-identical.
      targetedSetBonuses: setBonusTargets.length > 0 || (env.base.armor.targetedSetBonuses ?? []).length > 0
        ? [...(env.base.armor.targetedSetBonuses ?? []), ...setBonusTargets]
        : env.base.armor.targetedSetBonuses,
```

Pass it as the 9th argument to `generateCandidates`:

```typescript
    { ...env, fragmentCap }, frag, perk, cap, weaponPicks, exoticHash, allAspects, modPicks,
    setBonusTargets,
```

Extend the `addable` filter to exclude the new kind:

```typescript
    .filter((c) => c.kind !== "weapon" && c.kind !== "exoticArmor" && c.kind !== "aspect"
      && c.kind !== "mod" && c.kind !== "setBonus")
```

and push the reach after the mod reach block:

```typescript
  // Credit the reach only while the plan can still afford another target: a spent budget
  // contributes nothing further, so the bound tightens as the plan fills. Set-bonus candidates
  // are filtered OUT of `addable` above precisely because this covers them — dropping this push
  // makes the bound ignore the dimension and UNDER-estimate any plan-unfinished state, breaking
  // the admissibility SP3a's pruning depends on.
  //
  // Loose on purpose: with 2 pieces left the reach still credits 4-piece bonuses, which
  // over-credits and so stays admissible. Tightening it by affordability is a possible
  // optimisation, not a correctness fix.
  if (env.setBonusPool !== undefined && remainingPieceBudget(setBonusTargets) > 0) {
    addable.push(...(env.setBonusReach ?? []));
  }
```

`expand` — add a branch before the `weapon` branch:

```typescript
    } else if (c.kind === "setBonus") {
      out.push(makeState(env, {
        ...sel,
        setBonusTargets: [...sel.setBonusTargets, { setHash: c.hash, pieceCount: c.pieceCount! }],
      }, bound));
```

`dimensionsAllDecided` — add **no clause**, but document why, after the mods comment:

```typescript
  // SET BONUSES DELIBERATELY HAVE NO CLAUSE EITHER, for the same reason as mods. They are
  // OPTIONAL — five pieces from five different sets is a legal build — so underfill is legal and
  // a state that can afford no further target is MAXIMAL rather than incomplete. A tagged bonus
  // has no downside today, so maximal is optimal and terminal-only routing holds without
  // best-partial tracking.
  //
  // ⚠️ SP4 BREAKS THAT ARGUMENT: once targeting constrains which pieces (and so which stats) a
  // build can have, a target DOES have a downside. Revisit here, together with the two dominance
  // exclusions in `deriveSetBonusPool`.
```

- [ ] **Step 7: Run the tests and verify they pass**

Run: `npx vitest run tests/solver/beam-set-bonuses.test.ts && npx tsc --noEmit`
Expected: all PASS, `tsc` clean.

- [ ] **Step 8: Verify byte-compatibility explicitly**

Run: `npx vitest run tests/solver`
Expected: every pre-existing solver test PASSES **unchanged in expectation**. If any test asserting a
score, a key or a top build has changed, the dimension is leaking while closed — STOP and find out
why before proceeding. The only edits to existing test files in this task are the mechanical
`setBonusTargets: []` additions from Step 3.

- [ ] **Step 9: Prove the budget gate and the canonical sort are load-bearing**

Mutation A — remove the budget gate:

```bash
python3 - <<'PY'
p="src/lib/solver/candidates.ts"
s=open(p).read()
old="      if (option.target.pieceCount > budget) continue;"
assert s.count(old)==1, f"target count {s.count(old)}"
open(p,"w").write(s.replace(old,"      // MUTATION"))
PY
grep -n "MUTATION" src/lib/solver/candidates.ts   # MUST print a line
npx vitest run tests/solver/beam-set-bonuses.test.ts   # the 3 budget tests MUST fail
```

Revert (`grep -c MUTATION` → `0`), then Mutation B — drop the canonical sort in `stateKey`:

```bash
python3 - <<'PY'
p="src/lib/solver/beam.ts"
s=open(p).read()
old="      .sort((a, b) => a.setHash - b.setHash || a.pieceCount - b.pieceCount)\n      .map((t) => `${t.setHash}x${t.pieceCount}`)"
assert s.count(old)==1, f"target count {s.count(old)}"
open(p,"w").write(s.replace(old,"      .map((t) => `${t.setHash}x${t.pieceCount}`) // MUTATION"))
PY
grep -n "MUTATION" src/lib/solver/beam.ts   # MUST print a line
npx vitest run tests/solver/beam-set-bonuses.test.ts   # the sorted-key test MUST fail
```

Revert and confirm `grep -c MUTATION src/lib/solver/beam.ts` → `0`.

- [ ] **Step 10: Run the full suite and commit**

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`
Expected: 466 passing (453 + 13), 56 files, 0 failing.

```bash
git add src/lib/solver/types.ts src/lib/solver/candidates.ts src/lib/solver/beam.ts src/lib/solver/set-bonuses.ts tests/solver/
git commit -m "feat(solver): wire the set-bonus dimension into the beam, opt-in

Add-one-target moves, <=2 extra levels: a move is a (set, threshold) pair, gated
by the remaining piece budget and by the set not already being targeted (a
second entry would contradict cumulative thresholds rather than refine them).

Additive, as slices 1/2b/2c were: the |set: key segment is appended LAST and
only when non-empty, so every state key written before this dimension is
byte-identical. Selection.setBonusTargets is REQUIRED, not optional - tsc
enumerated all 25 existing call sites, which is the checklist.

setBonus candidates are filtered OUT of the bound's addable set and covered by
the reach push instead, the same treatment weapon/exotic/aspect/mod moves get.
The push is gated on remaining budget so the bound tightens as the plan fills;
it stays deliberately loose about affordability, which over-credits and so
remains admissible.

dimensionsAllDecided gets NO clause, with the reasoning recorded: set bonuses
are optional, so underfill is legal and a state that can afford no further
target is maximal rather than incomplete. Flagged that SP4 breaks that argument.

Mutation-proven: removing the budget gate reddens 3, dropping stateKey's
canonical sort reddens 1."
```

---

### Task 5: The synthetic admissibility gate

**Files:**
- Modify: `tests/solver/beam-set-bonuses.test.ts` (append one `describe`)

**Interfaces:**
- Consumes: the fixture `ctxFor`/`base` from Task 4, `makeState`, `synergyUpperBound`, `scoreSynergy`.
- Produces: nothing consumed by later tasks.

**Why this is its own task and why SYNTHETIC:** per the slice-2b structural rule, this dimension is
multi-move but **single-stage** — a target's reward is realized immediately, not behind a stage
boundary — so an outcome gate ("the winner changes when the reach is deleted") would likely pass
**vacuously**. Slice 2c's first real-data admissibility gate passed with the reach term deleted,
because the other dimensions' reach already dominated any single mod. The fixture from Task 4 makes
the only producer of the pinned fragment's consumed keyword a SET BONUS, which isolates the reward.

- [ ] **Step 1: Write the failing test**

Append to `tests/solver/beam-set-bonuses.test.ts`:

```typescript
describe("synergyUpperBound — admissibility over the set-bonus dimension", () => {
  it("bound on a plan-unfinished state dominates every single-target completion", () => {
    const env = buildSolverEnv(base(), ctxFor(), { chooseSetBonuses: true })!;
    // Consumer fragment pinned, nothing targeted yet. The only "jolt" producer in the fixture
    // is a set bonus, so the bound can see the reward ONLY through `setBonusReach`.
    const state = makeState(env, {
      fragHashes: [fragConsumer.hash], perkHashes: [], weapons: [], aspectHashes: [], mods: [],
      setBonusTargets: [],
    }, synergyUpperBound);

    const moves = state.candidates.filter((c) => c.kind === "setBonus");
    // Anti-vacuity: an empty list makes Math.max(...[]) === -Infinity and passes trivially.
    expect(moves.length).toBeGreaterThan(0);

    const realized = moves.map((c) => scoreSynergy({
      ...state.build,
      armor: {
        ...state.build.armor,
        targetedSetBonuses: [{ setHash: c.hash, pieceCount: c.pieceCount! }],
      },
    }, env.lookup).score);

    // The gate must have something to dominate, or deleting the reach term would be invisible.
    expect(Math.max(...realized)).toBeGreaterThan(0);
    expect(state.priority).toBeGreaterThanOrEqual(Math.max(...realized));
  });

  it("also dominates a full TWO-target completion", () => {
    // The plan space allows two 2-piece targets, so the bound must dominate the best complete
    // plan, not merely the best first move.
    const env = buildSolverEnv(base(), ctxFor(), { chooseSetBonuses: true })!;
    const state = makeState(env, {
      fragHashes: [fragConsumer.hash], perkHashes: [], weapons: [], aspectHashes: [], mods: [],
      setBonusTargets: [],
    }, synergyUpperBound);

    const full = scoreSynergy({
      ...state.build,
      armor: {
        ...state.build.armor,
        targetedSetBonuses: [{ setHash: 902, pieceCount: 2 }, { setHash: 903, pieceCount: 2 }],
      },
    }, env.lookup).score;

    expect(full).toBeGreaterThan(0);
    expect(state.priority).toBeGreaterThanOrEqual(full);
  });
});
```

Add `scoreSynergy` to the file's `@/lib/synergy` import.

- [ ] **Step 2: Run and verify it passes**

Run: `npx vitest run tests/solver/beam-set-bonuses.test.ts`
Expected: PASS. (Unlike most tasks this test passes on first run — the implementation landed in
Task 4. Its value is proven by the mutation in Step 3, which is the whole point of the task.)

- [ ] **Step 3: Prove the gate is load-bearing — the crux of this slice**

Delete the reach push and confirm the gate reddens:

```bash
python3 - <<'PY'
p="src/lib/solver/beam.ts"
s=open(p).read()
old="  if (env.setBonusPool !== undefined && remainingPieceBudget(setBonusTargets) > 0) {\n    addable.push(...(env.setBonusReach ?? []));\n  }"
assert s.count(old)==1, f"target count {s.count(old)}"
open(p,"w").write(s.replace(old,"  // MUTATION: reach push deleted"))
PY
grep -n "MUTATION" src/lib/solver/beam.ts   # MUST print a line
npx vitest run tests/solver/beam-set-bonuses.test.ts
```

Expected: **BOTH admissibility tests FAIL** with `state.priority` below the realized maximum.

**If they PASS, the gate is VACUOUS and must be fixed, not accepted.** That is exactly what happened
to slice 2c's first attempt. Diagnose by printing `state.priority` and `realized`: the usual cause is
another dimension's reach still supplying the keyword, so tighten the fixture until the set bonus is
genuinely the only path to the reward.

Revert and confirm:

```bash
python3 - <<'PY'
p="src/lib/solver/beam.ts"
s=open(p).read()
old="  // MUTATION: reach push deleted"
assert s.count(old)==1
new="  if (env.setBonusPool !== undefined && remainingPieceBudget(setBonusTargets) > 0) {\n    addable.push(...(env.setBonusReach ?? []));\n  }"
open(p,"w").write(s.replace(old,new))
PY
grep -c MUTATION src/lib/solver/beam.ts   # MUST print 0
npx vitest run tests/solver/beam-set-bonuses.test.ts   # green again
```

- [ ] **Step 4: Run the full suite and commit**

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`
Expected: 468 passing (466 + 2), 56 files, 0 failing.

```bash
git add tests/solver/beam-set-bonuses.test.ts
git commit -m "test(solver): pin set-bonus reach admissibility with a synthetic gate

This dimension is multi-move but SINGLE-STAGE - a target's reward is realized
immediately, not behind a stage boundary - so per the slice-2b structural rule
an outcome gate would likely pass vacuously. Admissibility is the real property.

SYNTHETIC on purpose: slice 2c's first real-data admissibility gate PASSED with
the reach term deleted, because the other dimensions' reach already dominated
any single mod. Here the only producer of the pinned fragment's consumed keyword
is a set bonus, which isolates the reward.

Two assertions: the bound on a plan-unfinished state dominates the best single
target AND the best full two-target plan. Mutation-proven - deleting the
setBonusReach push reddens both."
```

---

### Task 6: Reject a pinned illegal plan

**Files:**
- Modify: `src/lib/solver/types.ts` (`InfeasibilityCode`, lines 67-76)
- Modify: `src/lib/solver/beam.ts` (`resolveSolverEnv`)
- Test: `tests/solver/infeasibility.test.ts`

**Interfaces:**
- Consumes: `SET_PIECE_BUDGET` (Task 1), `remainingPieceBudget` (Task 2).
- Produces: `InfeasibilityCode` gains `"SET_TARGET_PLAN_ILLEGAL"`.

**Why:** a silently-ignored bad pin is precisely the defect slice 4 closed with
`EXOTIC_PIN_CONTRADICTS_PINNED_PIECE`. Nothing can pin a plan through the UI yet; this keeps the seam
honest for when something can. Causes **accumulate** rather than short-circuit, per slice 4.

- [ ] **Step 1: Add the code**

In `src/lib/solver/types.ts`, add to `InfeasibilityCode` after `"ASPECT_POOL_TOO_SMALL"`:

```typescript
  | "SET_TARGET_PLAN_ILLEGAL"
```

- [ ] **Step 2: Write the failing tests**

Add to `tests/solver/infeasibility.test.ts`, following that file's existing helper style for
constructing a base build and calling `resolveSolverEnv`:

```typescript
describe("SET_TARGET_PLAN_ILLEGAL", () => {
  const withTargets = (targetedSetBonuses: { setHash: number; pieceCount: number }[]) => {
    const b = base();
    b.armor = { ...b.armor, targetedSetBonuses };
    return b;
  };

  it("reports a pinned plan needing more than 4 pieces", () => {
    const { env, reasons } = resolveSolverEnv(
      withTargets([{ setHash: SET_A, pieceCount: 4 }, { setHash: SET_B, pieceCount: 2 }]),
      ctx(),
    );
    expect(env).toBeNull();
    expect(reasons.map((r) => r.code)).toContain("SET_TARGET_PLAN_ILLEGAL");
  });

  it("reports a pinned threshold that is not 2 or 4", () => {
    const { reasons } = resolveSolverEnv(withTargets([{ setHash: SET_A, pieceCount: 3 }]), ctx());
    expect(reasons.map((r) => r.code)).toContain("SET_TARGET_PLAN_ILLEGAL");
  });

  it("reports the same set pinned twice", () => {
    const { reasons } = resolveSolverEnv(
      withTargets([{ setHash: SET_A, pieceCount: 2 }, { setHash: SET_A, pieceCount: 2 }]),
      ctx(),
    );
    expect(reasons.map((r) => r.code)).toContain("SET_TARGET_PLAN_ILLEGAL");
  });

  it("accepts a legal pinned plan", () => {
    const { env, reasons } = resolveSolverEnv(
      withTargets([{ setHash: SET_A, pieceCount: 2 }, { setHash: SET_B, pieceCount: 2 }]),
      ctx(),
    );
    expect(reasons.map((r) => r.code)).not.toContain("SET_TARGET_PLAN_ILLEGAL");
    expect(env).not.toBeNull();
  });

  it("is silent when nothing is pinned, so no existing build changes verdict", () => {
    const { reasons } = resolveSolverEnv(base(), ctx());
    expect(reasons.map((r) => r.code)).not.toContain("SET_TARGET_PLAN_ILLEGAL");
  });
});
```

`SET_A`/`SET_B` must be set hashes present in that file's context. If its fixture has no
`armorSets`, add two minimal ones and the matching `setToPieces` keys, mirroring Task 2's
`setOnly2`/`setBoth`.

- [ ] **Step 3: Run and verify they fail**

Run: `npx vitest run tests/solver/infeasibility.test.ts`
Expected: the first three FAIL (code never emitted). The last two PASS as regression guards.

- [ ] **Step 4: Implement**

In `resolveSolverEnv`, alongside the other pinned-input checks (before the
`if (reasons.length > 0 …)` guard):

```typescript
  // A PINNED targeted plan must itself be legal. Reported rather than silently extended: an
  // ignored bad pin is the defect slice 4 closed for exotics. This duplicates the validator's
  // `targetedSetBonusPlan` conditions on purpose — the validator judges a finished build, while
  // this explains an unsatisfiable INPUT before the beam runs, and slice 4's contract is that
  // env-level codes are proofs about the inputs.
  const pinnedTargets = base.armor.targetedSetBonuses ?? [];
  if (pinnedTargets.length > 0) {
    const seenSets = new Set<Hash>();
    const problems: string[] = [];
    for (const t of pinnedTargets) {
      if (t.pieceCount !== 2 && t.pieceCount !== 4) {
        problems.push(`set ${t.setHash} is pinned at ${t.pieceCount} pieces, but a set bonus `
          + "activates at 2 or 4");
      }
      if (seenSets.has(t.setHash)) {
        problems.push(`set ${t.setHash} is pinned more than once, but thresholds are cumulative `
          + "so one entry per set is both sufficient and required");
      }
      seenSets.add(t.setHash);
    }
    if (remainingPieceBudget(pinnedTargets) < 0) {
      problems.push(`the pinned plan needs ${SET_PIECE_BUDGET - remainingPieceBudget(pinnedTargets)}`
        + ` legendary pieces but only ${SET_PIECE_BUDGET} are available`);
    }
    if (problems.length > 0) {
      reasons.push({
        code: "SET_TARGET_PLAN_ILLEGAL",
        message: `The pinned set-bonus plan is not achievable: ${problems.join("; ")}.`,
        hashes: pinnedTargets.map((t) => t.setHash),
      });
    }
  }
```

Add `SET_PIECE_BUDGET` to the `@/lib/types` value import in `beam.ts`.

Note `remainingPieceBudget` returns a NEGATIVE number for an over-budget plan, which is why the test
is `< 0` rather than `> SET_PIECE_BUDGET`.

- [ ] **Step 5: Run and verify they pass**

Run: `npx vitest run tests/solver/infeasibility.test.ts && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 6: Prove accumulation, then commit**

Confirm causes accumulate rather than short-circuit — a plan that is BOTH over budget and duplicated
must still yield exactly one `SET_TARGET_PLAN_ILLEGAL` whose message names both problems. Add:

```typescript
  it("names every problem in one reason, since causes accumulate", () => {
    const { reasons } = resolveSolverEnv(
      withTargets([{ setHash: SET_A, pieceCount: 4 }, { setHash: SET_A, pieceCount: 4 }]),
      ctx(),
    );
    const reason = reasons.find((r) => r.code === "SET_TARGET_PLAN_ILLEGAL")!;
    expect(reason.message).toMatch(/more than once/);
    expect(reason.message).toMatch(/only 4 are available/);
  });
```

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`
Expected: 474 passing (468 + 6), 56 files, 0 failing.

```bash
git add src/lib/solver/types.ts src/lib/solver/beam.ts tests/solver/infeasibility.test.ts
git commit -m "feat(solver): report SET_TARGET_PLAN_ILLEGAL for a pinned illegal plan

A silently-ignored bad pin is the defect slice 4 closed with
EXOTIC_PIN_CONTRADICTS_PINNED_PIECE. Nothing can pin a plan through the UI yet;
this keeps the seam honest for when something can.

Deliberately duplicates targetedSetBonusPlan's conditions: the validator judges
a finished build, while this explains an unsatisfiable INPUT before the beam
runs, which is slice 4's env-level contract. Problems accumulate into one
reason naming all of them rather than short-circuiting on the first."
```

---

### Task 7: Real-data integration, cost measurement, and the default-on decision

**Files:**
- Create: `tests/solver/integration-set-bonuses.test.ts`
- Modify: `src/lib/solver/types.ts` (only if the default flips)
- Modify: `docs/HANDOFF.md` (record the measured factor)

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: the measured marginal factor, and the final default for `chooseSetBonuses`.

- [ ] **Step 1: Write the integration + arithmetic tests**

Create `tests/solver/integration-set-bonuses.test.ts`:

```typescript
import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import { createLookup, validateBuild } from "@/lib/validation";
import type { Build, SubclassElement, GuardianClass } from "@/lib/types";
import { SET_PIECE_BUDGET } from "@/lib/types";

import { solve } from "@/lib/solver";

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));

const CASES: { element: SubclassElement; classType: Exclude<GuardianClass, "any"> }[] = [
  { element: "arc", classType: "warlock" },
  { element: "solar", classType: "titan" },
  { element: "stasis", classType: "hunter" },
];

describe.runIf(hasDataset)("set bonuses — real data", () => {
  const setup = async () => {
    const dataset = await loadDataset();
    const lookup = createLookup(dataset);
    return { lookup, ctx: { lookup, indexes: dataset.indexes } };
  };
  const buildFor = (
    element: SubclassElement, classType: Exclude<GuardianClass, "any">, artifactHash: number,
  ) => ({
    subclass: { element, classType, aspectHashes: [], fragmentHashes: [] },
    weapons: [],
    armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
    artifact: { artifactHash, selectedPerkHashes: [] },
    constraints: [],
  }) as unknown as Build;

  it("produces a build whose targeted plan passes validateBuild with ZERO game violations", async () => {
    // THE assertion this whole slice exists for. Written to armor.setBonuses instead, this
    // emits SET_COUNT_INVALID on every build, because the solver never writes armor.pieces.
    const { lookup, ctx } = await setup();
    const artifact = lookup.currentArtifact()!;
    const result = solve(buildFor("arc", "warlock", artifact.hash), ctx, { chooseSetBonuses: true });

    expect(result.feasible).toBe(true);
    const top = result.builds[0];
    expect(top.build.armor.targetedSetBonuses ?? []).not.toHaveLength(0);

    const violations = validateBuild(top.build, lookup).violations.filter((v) => v.category === "game");
    expect(violations.map((v) => v.code)).not.toContain("SET_COUNT_INVALID");
    expect(violations).toEqual([]);
  }, 300_000);

  it("satisfies the plan arithmetic on every ranked build, across elements and classes", async () => {
    const { lookup, ctx } = await setup();
    const artifact = lookup.currentArtifact()!;
    for (const { element, classType } of CASES) {
      const result = solve(buildFor(element, classType, artifact.hash), ctx, { chooseSetBonuses: true });
      expect(result.feasible, element).toBe(true);
      for (const ranked of result.builds) {
        const plan = ranked.build.armor.targetedSetBonuses ?? [];
        const label = `${element}/${classType}: ${JSON.stringify(plan)}`;
        // Asserted on the PLAN, not merely on feasibility.
        const sets = plan.map((t) => t.setHash);
        expect(new Set(sets).size, label).toBe(sets.length);
        for (const t of plan) expect([2, 4], label).toContain(t.pieceCount);
        const pieces = plan.reduce((n, t) => n + t.pieceCount, 0);
        expect(pieces, label).toBeLessThanOrEqual(SET_PIECE_BUDGET);
        // A 4-piece plan is never combined with another target.
        if (plan.some((t) => t.pieceCount === 4)) expect(plan, label).toHaveLength(1);
      }
    }
  }, 600_000);

  it("earns its cost — the top score rises when the dimension opens", async () => {
    const { lookup, ctx } = await setup();
    const artifact = lookup.currentArtifact()!;
    const build = buildFor("arc", "warlock", artifact.hash);
    const closed = solve(build, ctx, {});
    const open = solve(build, ctx, { chooseSetBonuses: true });
    expect(open.builds[0].score).toBeGreaterThan(closed.builds[0].score);
  }, 300_000);
});
```

- [ ] **Step 2: Run and verify**

Run: `npx vitest run tests/solver/integration-set-bonuses.test.ts`
Expected: all PASS. If the "zero game violations" test fails on a code OTHER than
`SET_COUNT_INVALID`, that is a pre-existing rule the solver's build trips — record it and raise it
rather than loosening the assertion.

- [ ] **Step 3: Measure the marginal cost and re-verify the tripwire**

Write a throwaway script (put it in the scratchpad, do NOT commit it) that counts bound calls with
the dimension closed and open, mirroring how the weapons tripwire test counts them — find that test
with `grep -rn "10,527\|10527" tests/` and copy its counting harness exactly, so the figures are
comparable.

Record four numbers:

| Measurement | Value |
| --- | --- |
| bound calls, `chooseSetBonuses: false` | (expect ~6,643 for arc/warlock, beamWidth 8) |
| bound calls, `chooseSetBonuses: true` | ? |
| marginal factor | ? (spec estimated ~1,400 added calls) |
| weapons tripwire | **MUST be exactly 10,527** |

If the tripwire moved, STOP — the slice is not additive and something leaks while the dimension is
closed.

- [ ] **Step 4: Decide the default, against the spec's two gates**

Ship `chooseSetBonuses: true` by default **only if BOTH** hold:

1. the marginal factor is ≲2.5× (the exotic dimension ships on at 2.72×), **and**
2. the churn in existing test expectations is small and reviewable.

To measure gate 2, temporarily flip the default in `resolveSolverEnv`
(`options.chooseSetBonuses !== false`), run `npx vitest run`, and count the failures. Because the
pool is class-independent, expect every test asserting an exact score or top build to change.

**If either gate fails, keep the default `false`** and record why — that is a legitimate outcome, not
a failure, and it matches the mods decision. Do not flip the default silently either way; the
reasoning goes in the commit message and the handoff.

- [ ] **Step 5: Record the measurements in the handoff and commit**

Add the measured factor to `docs/HANDOFF.md` beside the existing invariants (exotic 2.72×, aspect
1.21×, mods 5.37×), and update the "Measured invariants" block plus the test baseline count.

```bash
git add tests/solver/integration-set-bonuses.test.ts docs/HANDOFF.md src/lib/solver/types.ts
git commit -m "feat(solver): integrate set bonuses on real data, measured

The assertion this slice exists for: a solver-produced build carrying a targeted
plan passes validateBuild with ZERO game violations and no SET_COUNT_INVALID.
Written to armor.setBonuses this fails on every build.

Plan arithmetic asserted on the PLAN across arc/warlock, solar/titan and
stasis/hunter: sets distinct, thresholds in {2,4}, total <= 4, and a 4-piece plan
never combined with another target.

Weapons tripwire re-verified at exactly 10,527, proving the slice is additive.
Marginal factor and the resulting chooseSetBonuses default recorded in
docs/HANDOFF.md alongside exotic 2.72x, aspect 1.21x and mods 5.37x."
```

---

### Task 8: Show the targeted plan in the UI

**Files:**
- Modify: `src/lib/ui/recommend.ts` (`BuildDisplay`, `resolveDisplay`)
- Modify: `src/app/page.tsx` (the `<dl>` summary)
- Test: `tests/ui/recommend.test.ts`

**Interfaces:**
- Consumes: `BuildDisplay`/`resolveDisplay` from commit `f28b9e6`; `Lookup.armorSet`.
- Produces: `BuildDisplay.setBonusNames: string[]`.

**Note:** if Task 7 left `chooseSetBonuses` defaulting to `false`, `recommend()` must pass
`chooseSetBonuses: true` explicitly for the row to ever populate — decide that alongside the
`chooseMods` precedent (which `RecommendInput` exposes as an option). Mirror it: add
`chooseSetBonuses?: boolean` to `RecommendInput` and default it to whatever Task 7 decided.

- [ ] **Step 1: Write the failing test**

Add to the `"recommend — resolved display names"` describe in `tests/ui/recommend.test.ts`:

```typescript
  it("names the targeted set bonuses with their piece counts", async () => {
    const { result, displays } = await recommend({
      element: "arc", classType: "warlock", chooseSetBonuses: true,
    });
    const ds = await loadDataset();
    const plan = result.builds[0].build.armor.targetedSetBonuses ?? [];
    expect(plan.length).toBeGreaterThan(0);

    // Derived from the dataset ARRAY while recommend() resolves through the Lookup MAP — two
    // independent paths, so agreement means the right set was resolved.
    expect(displays[0].setBonusNames).toEqual(
      plan.map((t) => `${ds.armorSets.find((s) => s.hash === t.setHash)?.name} · ${t.pieceCount} pieces`),
    );
    for (const name of displays[0].setBonusNames) expect(name).toMatch(/\S/);
  }, 300_000);

  it("leaves the set-bonus row empty when the dimension is closed", async () => {
    const { displays } = await recommend({ element: "arc", classType: "warlock" });
    expect(displays[0].setBonusNames).toEqual([]);
  }, 120_000);
```

The existing `"puts no bare hash in any displayed value"` test covers the new field automatically —
it flattens `Object.values(display)`. Verify that claim holds by checking the new test run includes
it green.

- [ ] **Step 2: Run and verify it fails**

Run: `npx vitest run tests/ui/recommend.test.ts`
Expected: FAIL — `setBonusNames` is `undefined`.

- [ ] **Step 3: Implement**

In `src/lib/ui/recommend.ts`, add to `BuildDisplay`:

```typescript
  /**
   * Targeted set bonuses, one entry per TARGET as `"<set name> · <n> pieces"`.
   *
   * The TARGET is displayed rather than the activated bonus names, because the target is the
   * actionable prescription ("go obtain 4 pieces of this set") while the perks it activates are
   * its consequence. Empty when the dimension is closed.
   */
  setBonusNames: string[];
```

and in `resolveDisplay`, add to the returned object:

```typescript
    setBonusNames: (build.armor.targetedSetBonuses ?? []).map((t) => {
      const set = lookup.armorSet(t.setHash);
      if (set === undefined) {
        throw new Error(`Unresolvable armour set hash ${t.setHash} in solved build`);
      }
      return `${set.name} · ${t.pieceCount} pieces`;
    }),
```

Add `chooseSetBonuses?: boolean` to `RecommendInput` (documented like `chooseMods`) and thread it
into the `solve` options.

In `src/app/page.tsx`, add a row to the `<dl>` after `Exotic armour`:

```tsx
        <dt className="text-xs uppercase tracking-wide text-gray-400">Set bonuses</dt>
        <dd>{display.setBonusNames.join(" · ") || "—"}</dd>
```

- [ ] **Step 4: Run and verify it passes**

Run: `npx vitest run tests/ui/recommend.test.ts && npx tsc --noEmit && npx eslint scripts src tests`
Expected: all PASS.

- [ ] **Step 5: Verify by RENDERING, not just building**

```bash
npx next build
(npx next start -p 3117 > /tmp/next-start.log 2>&1 &)
for i in $(seq 1 40); do curl -sf -o /dev/null http://localhost:3117/ && break; sleep 1; done
curl -s "http://localhost:3117/?element=arc&class=warlock" \
 | python3 -c "
import sys,re,html
t=re.sub(r'<script.*?</script>','',sys.stdin.read(),flags=re.S)
t=html.unescape(re.sub(r'<[^>]+>',' ',t))
print('bare 4+ digit runs:', re.findall(r'(?<!\d)\d{4,}(?!\d)',t) or 'NONE')
m=re.search(r'Set bonuses\s*(.*?)\s*Artifact perks', re.sub(r'\s+',' ',t))
print('set bonus row:', m.group(1) if m else '(row missing)')
"
```

Expected: real set names with piece counts (or `—` if the dimension defaults closed), and
`bare 4+ digit runs: NONE`.

Kill the server **by port**, not with `pkill -f "next start"` — that pattern matches the killing
command's own shell and terminates it:

```bash
PID=$(ss -ltnp 2>/dev/null | grep ':3117' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
[ -n "$PID" ] && kill "$PID"
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/ui/recommend.ts src/app/page.tsx tests/ui/recommend.test.ts
git commit -m "feat(ui): show the targeted set bonuses in the recommender

One BuildDisplay field and one row, on the seam from f28b9e6. Without it the
page silently hides a decision the solver made.

Displays the TARGET (\"<set> · <n> pieces\") rather than the activated bonus
names: the target is the actionable prescription, the perks are its consequence.
Resolves through Lookup.armorSet and throws on an unresolvable hash, consistent
with every other field. The existing no-bare-hash assertion covers the new field
for free because it flattens Object.values(display).

Verified by RENDERING via next start + curl, not only by next build."
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: the field split → Task 1; pool/reach/budget
including the 58 count and both dominance exclusions → Task 2; cumulative activation → Task 3; beam
wiring, the class-independent pool, byte-compatibility, and the no-`dimensionsAllDecided`-clause
decision → Task 4; the synthetic admissibility gate and the single-stage reasoning → Task 5;
`SET_TARGET_PLAN_ILLEGAL` → Task 6; the four proving assertions, the tripwire, the cost factor and
the two default-on gates → Task 7; `setBonusNames` and the page row → Task 8. The reach trap (no
tag-signature dedup) is carried in Global Constraints **and** in Task 2's implementation comment.

**Two spec deviations, both deliberate and flagged in place.** `SET_PIECE_BUDGET` lives in
`src/lib/types/build.ts` rather than the solver module, because validation needs it and must not
import the solver (Task 1, Step 1). And `deriveSetBonusPool` returns `SetBonusOption[]` (target +
precomputed element) rather than bare `TargetedSetBonus[]`, because `generateCandidates` has no
`Lookup` with which to resolve a candidate's element — established in Task 2, where the module is
created, so Task 4 only consumes it. `deriveSetBonusReach` takes bare **targets** rather than
options, so it stays callable from a test without fabricating an element.

**Type consistency.** `TargetedSetBonus` / `SET_PIECE_BUDGET` / `SetBonusOption` /
`setBonusTargets` / `setBonusPool` / `setBonusReach` / `setBonusNames` / `chooseSetBonuses` /
`SET_TARGET_INVALID` / `SET_TARGET_PLAN_ILLEGAL` are each used with one spelling throughout.
`pieceCount` is the field name everywhere; `requiredCount` appears only when reading the dataset's
`ArmorSetBonus`, which is correct — that is the dataset's own name for the threshold.

**Test-count arithmetic** (424 baseline → 431 → 448 → 453 → 466 → 468 → 474, plus Tasks 7-8) is an
expectation, not a contract. If a task's actual count differs, reconcile it rather than editing the
number — a surprise count means tests were added or lost that the plan did not anticipate.
