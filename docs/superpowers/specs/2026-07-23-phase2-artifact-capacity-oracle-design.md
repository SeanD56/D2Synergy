# Phase 2 · SP2 — Artifact Capacity Oracle (design)

> Validated design for SP2. Consumes: SP1 synergy engine (shipped), Phase 1 validator.
> Unblocks: SP3 beam-search solver. Flow: brainstorming (this doc) → writing-plans → subagent-driven-development.

## Reframing (the core decision)

The handoff scoped SP2 as "rework `Build.artifact` to a per-tier/socket structure." Brainstorming
resolved it **smaller**:

> **`Build.artifact` stays flat** (`selectedPerkHashes: Hash[]`). Sockets within a tier are
> fungible, and both consumers — the synergy engine and the SP3 solver — only read *which perks
> are active*, never *which socket* holds them. So no data-model rework is warranted (YAGNI).

**Driver (user-confirmed):** *solver feasibility only.* SP3's beam search needs a reliable
"is this perk set legal?" oracle as it adds perks incrementally. It does **not** need explicit
socket placement.

**Completeness finding (surfaced in brainstorming):** the Phase-1 `tierCapacity` "nested ceiling"
walk (high→low, cumulative need vs. cumulative sockets) is **already the exact Hall's-condition
feasibility test** for this nested/cumulative structure — its lowest-tier step (all perks ≤ 7
sockets) subsumes the separate total-count check. The handoff's "sound-but-partial" framing
understated it: the check is complete for *feasibility*. What the flat list genuinely can't
express is which socket each perk occupies — and feasibility-only doesn't need that.

So SP2's real work is not a model rework but: **extract that logic into a shared, precompute-backed
feasibility oracle**, prove its completeness, and give it a solver-friendly return shape.

## Structure recap (from Phase 0, binding)

- Artifacts sourced from `DestinyInventoryItemDefinition` "Artifact" items (bucket `1506418338`).
- **3 tiers, socket ceilings 2 / 3 / 2 = 7 equipped, no duplicates.**
- Tiers are a **ceiling**: a tier-T socket accepts its own perks **plus every lower tier's**. The
  derived `Artifact.tiers[].perks` pools are therefore **cumulative** (7 / 14 / 21) — the same perk
  hash appears in every tier at/above where it unlocks.
- A perk's **native tier** = the lowest tier it appears in; it is equippable in any socket of that
  tier or higher. (Memory: `artifact-tier-pools-cumulative`.)

## Module

New `src/lib/validation/artifact-capacity.ts` — **pure**, no `Lookup`, no filesystem.

- Lives in `validation/` because the `tierCapacity` rule consumes it today and the SP3 solver will
  import from `validation` anyway. Layering unchanged: synergy → validation; solver → both.

## API — precompute + fast eval (user-confirmed shape)

Beam search calls this in a hot loop (candidate perks × partial selections) on a RAM-constrained
machine, so per-artifact precompute is separated from per-selection evaluation.

```ts
/** Phase 1 — computed once per artifact; beam search hoists this out of its loop. */
export interface CapacityModel {
  nativeTier: Map<Hash, number>;   // perk hash -> lowest tier it appears in
  socketsByTier: number[];         // socketsByTier[t] = slots for tier t (e.g. [2, 3, 2])
  capacity: number;                // Σ socketsByTier (e.g. 7)
}
export function buildCapacityModel(artifact: Artifact): CapacityModel;

/** Phase 2 — per selection, cheap. */
export interface Capacity {
  feasible: boolean;               // true iff NOT over capacity (partial is feasible)
  selected: number;                // count of placeable (known) selected perks
  capacity: number;                // == model.capacity
  headroomByTier: number[];        // headroomByTier[k], see semantics below
}
export function evaluate(model: CapacityModel, selectedHashes: Hash[]): Capacity;

/** Phase 3 — O(tier) incremental prune for beam search. */
export function canAdd(model: CapacityModel, cap: Capacity, nativeTier: number): boolean;
```

## Semantics (confirmed)

1. **`feasible` = "not over capacity."** A partial / underfilled selection *is* feasible. Matches
   partial-build semantics: the solver builds up incrementally and must never see a legal-so-far
   selection rejected.
2. **`headroomByTier[k]`** = free sockets available to a perk whose *native tier* is `k`
   = `(sockets with tier ≥ k) − (selected perks with native tier ≥ k)`.
   - `feasible` iff every `headroomByTier[k] ≥ 0`.
   - `canAdd(t)` iff `min(headroomByTier[0..t]) ≥ 1` (a native-tier-`t` perk consumes one unit from
     every threshold `k ≤ t`, since it counts in "native tier ≥ k" for all `k ≤ t`).
3. **Only placeable (known) perks count.** Unknown / name-only hashes are ignored by the oracle and
   remain `perkMembership`'s responsibility — unchanged.
4. **`UNDERFILLED` stays a validator-only rule**, not an oracle concern. The oracle answers "over?";
   "fill all 7 slots" is a build-canvas advisory emitted by the rule layer.

## Refactor + correctness

- `tierCapacity` rule becomes a **thin adapter**: `buildCapacityModel` → `evaluate` → emit
  `ARTIFACT_TIER_OVER_CAP` when `!feasible`, `ARTIFACT_TIER_UNDERFILLED` when `selected < capacity`.
  **No behavior change** — the nested walk it already performs *is* `evaluate`'s feasibility test,
  so existing validation tests stay green. `perkMembership` untouched.
- `Build.artifact` and all synergy code (`collectBuildElements` iterates `selectedPerkHashes`)
  untouched.

## Testing

- **Unit** (`tests/validation/artifact-capacity.test.ts`):
  - `buildCapacityModel` — cumulative-pool native tiers resolved to lowest tier; `socketsByTier`,
    `capacity`.
  - `evaluate` — feasible / infeasible-by-tier / partial / exact-fill; `headroomByTier` values.
  - `canAdd` — accepts a fitting perk, rejects one with no headroom at its tier threshold.
  - **Completeness** — brute-force a small synthetic artifact against a bipartite-matching reference
    for all selections up to capacity; assert `evaluate(...).feasible` matches the reference exactly
    (proves the check is complete Hall feasibility, not partial).
- **Integration** (existing `tests/validation` or a targeted add): a legal 7-perk real-dataset
  selection is feasible; an over-tier-3 selection is not.
- **Regression:** full suite + `tsc --noEmit` + `eslint scripts src tests` green. Baseline 63 pass.

## Out of scope (deferred, unchanged)

- Per-account unlock state (which perks a player owns) — OAuth, Phase 2 later.
- Champion / anti-barrier coverage — text-only data, needs an extraction pass.
- The SP3 solver's actual *use* of the oracle — SP2 delivers and tests the oracle only.

## Decisions log

- **`Build.artifact` stays flat.** No per-tier/socket rework. *Why:* sockets are fungible;
  consumers read the active perk set, not placement; feasibility-only driver. Supersedes the
  handoff's "rework `Build.artifact`" framing (which explicitly left "keep flat + matching check"
  open).
- **Feasibility oracle = precompute + fast eval + `canAdd`.** *Why:* hot-loop beam search on a
  RAM-constrained machine; hoist per-artifact work out of the inner loop.
- **The Phase-1 nested-ceiling check is already complete Hall feasibility**, not partial. SP2
  formalizes and tests this rather than adding new capability. *Why:* nested/upward-closed socket
  neighborhoods ⇒ binding Hall subsets are exactly "perks with native tier ≥ k".
- **Oracle = over-capacity only; `UNDERFILLED` stays in the rule layer.** *Why:* partial builds are
  feasible; underfilled is a canvas advisory, not a solver-legality concern.
