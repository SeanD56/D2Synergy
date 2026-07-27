# Phase 2 · SP3b slice 2b — Solver-chosen exotic armor

**Status:** design approved 2026-07-27, ready for an implementation plan.
**Predecessor:** slice 2a (dataset signals) — merge `47d6a35` on `main`.
**Baseline to preserve:** 176/176 tests (34 files), `tsc --noEmit` clean, `eslint scripts src tests` clean.

## Why this slice

Slice 2a made exotic armor *legible*: `exoticPerkHash` went 0% → 97.4% and exotic tag coverage
0.6% → 76.1%. Nothing consumes that yet. The solver still cannot answer "which exotic should I
build around?", which is arguably the most valuable question a buildcrafting tool answers, since
the exotic is usually the centerpiece of a build.

This slice adds exactly one open dimension to the existing beam: the exotic armor piece.

## Scope

**In scope**

- The solver chooses `armor.exoticHash` from the pool for the build's Guardian class.
- A `useExotic` pin is honoured when present (first consumer of a constraint that has been
  declared in `Build` since Phase 0 but wired to nothing).
- `SubclassLoadout.classType` — the build model gains an explicit Guardian class.
- The validator's `classConsistency` rule gets its deferred class-match clause completed.

**Out of scope, deliberately**

| Excluded | Owner |
| --- | --- |
| The other four armor pieces | SP4 stat optimizer (`armor.pieces` untouched) |
| Mods | slice 2c, after a mod capacity oracle |
| Set bonuses | the slice after 2c |
| Exotic class-item spirit pools | post-release (see `docs/HANDOFF.md`) |

### Why exotic-only, and why that is not a shortcut

Measured on the slice-2a dataset:

| | count | tagged | share |
| --- | --- | --- | --- |
| Non-exotic armor | 5,681 | 123 | **2.17%** |
| Exotic armor | 348 | 265 | **76.1%** |

Armour's synergy signal lives almost entirely in the exotic. A beam that also chose the other four
pieces would be searching 5,681 items for a 2.17% chance of any signal, while duplicating the job
SP4 exists to do. DIM's own writeup of why its Loadout Optimizer is slow
(<https://github.com/DestinyItemManager/DIM/wiki/Why-Loadout-Optimizer-is-slow-or-uses-a-lot-of-CPU>)
reports **77.7 trillion** combinations for a player holding 100 T5 pieces per slot at roughly 5M
combinations/second — and lists *"choosing specific exotics (eliminating one armor slot)"* as one of
the things that **shrinks** that search. Locking the exotic and handing the rest to a stat optimizer
is the same division of labour, arrived at from the other direction.

### Branching factor

| Dimension | Branching | Note |
| --- | --- | --- |
| Weapons (slice 1, shipped) | 762 | kinetic pool, real data |
| **Exotic armor (this slice)** | **≤47** | per class, after name-dedup |

The manifest carries **116 exotic entries but only 47 distinct names per class** (348 entries / 141
distinct names overall — a 2.47× duplication factor, the same duplication that refuted slice 2a's
plug-uniqueness hypothesis). The pool **must dedup by name** or the beam wastes 2.5× its branching
on identical items. There are no `classType: "any"` exotics — the split is a clean 116/116/116.

## Approach

**One more open beam dimension**, following the weapons slice's shape but simpler: an exotic's slot
is determined by the item, so there is no sub-slot staging (the weapons slice needed a second stage
to fill perk columns; this does not).

Two alternatives were considered and rejected:

- **Outer loop — pin each exotic, re-run the beam, merge top-N.** No beam changes and no
  delayed-reward concern, but ~47× cost (≈510k bound calls against today's 10,842) and
  *multiplicative* with every dimension added later — mods and aspects would turn it into a product.
  That is precisely the trap the DIM writeup describes.
- **Heuristic shortlist, then beam.** Layers an unproven pruning heuristic on top of a bound already
  proven admissible, risking exactly the delayed-reward builds the bound exists to protect.

## Architecture

New module `src/lib/solver/armor.ts`:

```ts
/** Exotics legal for this class, deduped by name (lowest hash wins), hash-sorted. */
export function deriveExoticArmorPool(
  ctx: SolverContext,
  classType: GuardianClass,
  pinnedHash?: Hash,
): Armor[]
```

Extensions to existing modules, all **additive with trailing default params** so SP3a and slice-1
state keys and results stay byte-identical:

- `candidates.ts` — new `exoticArmor` candidate kind, offered only while `exoticHash` is undecided.
- `beam.ts` — `SolverEnv.exoticPool` + `SolverEnv.exoticReach`; `SolverState.exoticHash?: Hash`;
  `stateKey(frag, perk, weapons, exoticHash?)`; terminal guard extended.
- `types/build.ts` — `SubclassLoadout.classType?: GuardianClass`.
- `validation/armor.ts` — complete the `classConsistency` class-match clause.

**No synergy-side change.** `collectBuildElements` already reads `build.armor.exoticHash`
(`src/lib/synergy/elements.ts:51`), so a chosen exotic contributes to realized score with no
plumbing. `indexes.exoticToClassSlot` (348 entries) is already the right shape for pool derivation.

`armor.pieces` is never written. The solver reports *which exotic*; SP4 later fills the remaining
four slots around it. This is also why no `exoticCount` violation fires — that rule requires
`pieces.length >= 5`.

## The class model

`classType` goes on `SubclassLoadout`, beside the existing `element` pin: a subclass *is*
class-specific (Solar Warlock), and `Subclass.classType` already exists on the entity side. A
`useClass` constraint was rejected — `Constraint` is for optional preferences the solver dispatches
on, and class is a hard input.

It is **optional, and that is load-bearing**: every existing test constructs `SubclassLoadout`
without it, so absent ⇒ dimension closed ⇒ today's behaviour exactly. This is the trailing-default
principle applied to the data model.

**Two representations, and they do different jobs.** A `useExotic` *constraint* **narrows the pool**;
a pre-set `armor.exoticHash` **closes the dimension outright**. So a constraint-pinned exotic still
flows through a real move and the state still records the choice in `exoticHash` — one code path, one
source of truth for "what was chosen", and a uniform terminal guard. A caller who pre-sets
`exoticHash` instead gets slice-1's pinned-slot behaviour (not searched at all).

The two are evaluated in that order: `exoticHash` set ⇒ closed, and nothing below applies.

| `classType` | `useExotic` constraint | Behaviour (given `exoticHash` is unset) |
| --- | --- | --- |
| absent | absent | dimension **closed** — byte-identical to today |
| absent | present | pool is the pinned exotic alone; no class available to check it against |
| present | absent | dimension opens; beam picks from the full class pool |
| present | present, class matches | pool narrows to one; beam picks it in one move |
| present | present, class mismatches | **env infeasible** ⇒ `feasible: false` |

## Data flow

1. `buildSolverEnv` reads `base.subclass.classType` and any `useExotic` constraint →
   `exoticPool`. An empty pool ⇒ `return null`, slice 1's existing infeasible-env signal.
2. `generateCandidates` emits one `exoticArmor` move per pool entry while
   `state.exoticHash === undefined`.
3. `makeState` sets `build.armor.exoticHash`; realized synergy picks it up via the existing
   `elements.ts` read. While undecided, the bound's `addable` set is augmented with `exoticReach`.
4. `stateKey` appends the exotic as a trailing component — byte-identical when absent.
5. A state is terminal only when fragments, artifact perks, weapons **and** the exotic (when its
   dimension is open) are all decided.

### Bound

`exoticReach` is the tag union of the whole pool, keyed by armor hash, used as `addable` while the
exotic is undecided. A superset of what any single completion can contribute ⇒ over-credits only ⇒
**admissible**, reusing `synergyUpperBound` verbatim exactly as slice 1 did.

Two non-goals, stated so they are not mistaken for oversights: no bound tightening for this
dimension (loose by design; `beamWidth` is the cost governor, as in slice 1), and no `exoticReach`
caching beyond the per-solve precompute.

**Dedup granularity — do not "simplify" this.** Slice 2a's load-bearing invariant is that
`collectBuildElements` and `deriveWeaponSlotReach` key plug elements identically
(`bridged?.hash ?? plugHash`). Exotic armor has no equivalent split — armor hashes *are* the synergy
identity — so `exoticReach` keys by armor hash directly and no bridging arises. Name-dedup happens
at **pool** construction, not in reach.

## Failure modes

All new infeasibility routes through the existing `buildSolverEnv → null` signal, producing
`feasible: false` with empty builds:

- a `useExotic` pin whose class contradicts `classType`;
- a pin naming a hash absent from the dataset;
- a `classType` with no exotics (unreachable on real data, reachable with stubs).

This slice deliberately does **not** distinguish which case fired — that is slice 4's
infeasibility-explanation work, and these three are useful inputs for it.

Determinism: name-dedup keeps the **lowest hash** per name; the pool is hash-sorted.

## Test plan

1. **Pool derivation** — class filter; dedup 116 → 47 on real data; hash-sorted; pin narrows to
   one; wrong-class pin ⇒ empty; unknown hash ⇒ empty.
2. **Candidate generation** — offered only while undecided; never re-offered once chosen; **no
   `exoticArmor` candidates at all when `classType` is absent**.
3. **Acceptance gate (the point of the slice).** An exotic producing a keyword consumed *only* by a
   fragment survives the beam at W=1 with the bound ON, and is pruned with a zero bound. Mirrors the
   SP3a and slice-1 gates. Per slice 2a's lesson, this must be verified **load-bearing** — the
   zero-bound run must genuinely produce a different winner, not merely pass.
4. **Byte-compatibility** — `stateKey` identical with the trailing param absent; the entire existing
   suite unchanged. The strongest regression guard available.
5. **Cost.** The existing weapons tripwire must still measure **exactly 10,842** bound calls — that
   is what proves this change is additive rather than merely non-breaking. The new exotic-dimension
   test gets its **own** ceiling, set from measurement (expected order 16k–33k for a ≤47-branch
   dimension, but the committed number comes from the measured run, not this estimate).
6. **Real-data integration** — class pinned ⇒ an exotic is chosen, is class-correct, carries tags,
   and scores ≥ the no-exotic baseline.
7. **Validator** — the newly-unblocked `classConsistency` clause: armor class must match
   `subclass.classType`.

Carried forward from slice 2a: any fixture encoding manifest **structure** is mutation-checked, and
real-data claims use floor assertions rather than `> 0`.

## Done means

Full suite green (176 existing + new), `tsc --noEmit` clean, `eslint scripts src tests` clean, the
acceptance gate demonstrated load-bearing in both directions, the existing weapons cost tripwire
still at 10,842, and the new dimension's measured cost recorded here.

## What later slices inherit

- **Slice 2c (mods)** needs a mod capacity oracle first, and that needs ingest data we do not emit:
  a socket-type → accepted-plug-category mapping. Armour carries `modSocketHashes` (exotics mostly
  6–7 sockets, 52 distinct socket types, with repeats such as `968742181`×3) but nothing says which
  mods those sockets accept. Precedent: SP3a could only choose artifact perks because SP2 built the
  capacity oracle first; mods are the same shape — a flat selection constrained by per-category
  socket capacity — except the structure is **categorical, not nested**, so SP2's upward-closed
  Hall's-condition shortcut does *not* transfer. 145 of 512 mods carry tags; none carry
  `championStuns`.
- **Slice 3 (solver-chosen aspects)** now has a class source, since aspect pools are class-specific
  too. It must still revisit SP3a's terminal-only routing if dynamic fragment caps ever permit
  underfill.
- **Cost fallback (offered by the user, unspent).** If real-data cost ever surprises us, the
  documented response is to *require* a `useExotic` pin rather than redesign the dimension. Not
  needed at ≤47 branching, and recorded so the option is not rediscovered from scratch.
