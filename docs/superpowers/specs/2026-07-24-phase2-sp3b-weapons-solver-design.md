# Phase 2 · SP3b (slice 1) — Weapons solver: perk-roll membership + roll selection — design

> Validated design. Consumes: SP3a solver core + beam search (shipped to `main`), SP1 synergy engine,
> the existing weapon validator (`src/lib/validation/weapons.ts`). Second slice of SP3 (the completion
> solver), first of the SP3b group. Flow: brainstorming (this doc) → writing-plans →
> subagent-driven-development (same as SP1/SP2/SP3a).

## Why THIS slice, and why now

SP3a proved the beam can solve **delayed-reward** cross-dimensional synergy over two *homogeneous*
open dimensions (fragments, artifact perks) whose candidates are a flat, statically-known set. SP3b
scales the solver to the remaining dimensions. **Weapons is the sharpest next risk** because it is the
first dimension that is NOT a flat candidate set:

- The open axis is **two-level and dependent** — first *which weapon* fills a slot, then *which plug
  per column* of that weapon. The plug pool does not exist until a weapon is chosen.
- Candidacy is a **membership query over roll pools** ("can this weapon roll X, and X+Y in the same
  column?"), not enumeration. This is the pattern SP3a explicitly deferred.
- Weapon choice is **coupled across slots** by an ammo-composition rule (no double-Primary).

Getting weapons right establishes the *dependent/staged candidate-generation* pattern the later SP3b
slices (exotic armor + mods, solver-chosen artifact/aspects with dynamic caps) will reuse.

## Decisions (this brainstorm)

1. **Open dimension = weapon selection AND its roll.** The solver chooses the weapon *and* which plug
   rolls in each column, optimizing the roll for synergy — not just filtering weapons by pinned perks.
   (User chose the fuller version over "perks are only a membership filter.")

2. **Search structure = staged incremental, reusing the SP3a beam.** "Select weapon W for this slot"
   is one addable `BuildElement`; choosing it *unlocks* W's per-column plug candidates as further
   elements the beam adds one at a time. Maximal reuse of SP3a's beam + terminal routing. The cost —
   dependent candidate generation and an open-slot bound over a not-yet-chosen weapon — is accepted.

3. **Open-slot bound = loose reachable-union, precomputed once.** For a slot with no weapon chosen,
   the optimistic bound's addable set is the **union of tags over all legal weapons in the slot and all
   their plugs**, fed straight into SP3a's existing `synergyUpperBound`. Provably admissible (it can
   only over-credit), zero new bound math, reuses the audited SP3a bound verbatim. The union is
   **static per (slot, pins)** so it is computed **once** at env-build time and cached — every bound
   call reads a precomputed per-keyword producer/consumer tally, O(keywords) not O(weapons×plugs).
   `beamWidth` is the cost governor. A **per-slot tightened bound** (max over legal weapons of a single
   weapon's contribution) is a **documented deferred optimization**, applied only if profiling shows
   the beam is too wide — safe to defer because tightening stays admissible (pure ranking/prune
   improvement, never a change to correctness).

4. **Ammo coupling = eager prune during expansion.** As soon as a partial build's chosen weapons make
   the no-double-Primary rule unsatisfiable, the state is pruned before its rolls are expanded — never
   explored. Adds cross-slot ammo feasibility to `expand`.

5. **Roll synergy via a plug-NAME bridge (Option B), with hash-tagging deferred (Option A).** See "Data
   reality" — weapon plug hashes are a different namespace than `perks.json`, so `lookup.perk(plugHash)`
   never resolves and weapon plugs carry no tags. v1 recovers a roll's synergy by resolving the plug's
   **name** to a tagged sandbox `Perk`: add `perkByName` to `Lookup`, and extend `collectBuildElements`
   to fall back to name-resolution for weapon `perkConstraints`. Proper hash-tagging of plugs at ingest
   (`transform.ts`) is the correct end state but is **deferred to the next legitimate re-ingest** (a
   full manifest re-fetch would drag in unrelated season churn + OOM risk on this box). When that
   re-ingest lands, plugs carry hash tags and the name bridge degrades to a harmless fallback.

## Data reality (empirically verified against `data/*.json`, 2026-07-24)

The approved brainstorm assumed a chosen roll contributes synergy "for free" via `lookup.perk` on the
plug hash. **The committed dataset contradicts this** — verified, not assumed:

- **Disjoint hash namespaces.** Weapon plug hashes are `plugItemHash` (inventory-item space);
  `perks.json` / `lookup.perk` are sandbox-perk space. **0 of 112,486** plug instances resolve by hash.
- **`weapon.tags` is element-only** for all 2,208 weapons (empty produces/consumes/triggers) — a weapon
  *selection* alone yields only element alignment, no keyword synergy.
- **Plugs carry no tags and no description** — `WeaponPerk` is `{hash, name}` (`transform.ts:281`). The
  ingest tags aspects/fragments/mods/artifact-perks but never tagged weapon plugs (a data-coverage gap).
- **The name bridge is sound.** 149 distinct plug names match a tagged `Perk` — **every one uniquely,
  zero ambiguous** — covering 12.1% of plug instances (exactly the synergy traits; the rest are
  barrels/mags/stat perks that correctly have no keywords). Spot-checks are exact: Voltshot→`jolt`,
  Incandescent→`scorch`, Destabilizing Rounds→`volatile` (produce+consume), Repulsor Brace→`overshield`,
  Firefly→`triggers:precision_kill`.
- **Residual risk (bounded by a test):** the bridge misses a synergy plug only if its sandbox perk was
  tagged empty / absent from `perks.json`; and names (unlike hashes) can drift across seasons. A
  **curated-resolution test** asserts a known trait set (Voltshot, Incandescent, Destabilizing Rounds,
  Repulsor Brace, Firefly, …) *must* resolve, so any regression fails CI loudly.

## Assumptions (reused code / natural defaults — flagged for correction)

- **Synergy of a roll flows through the name bridge, not the plug hash.** The solver expresses a chosen
  plug as a `PerkConstraint` carrying **both** `perkHash` (the `plugItemHash`, for identity / membership
  / pinning / output / dedup) **and** `perkName` (for synergy). `collectBuildElements` resolves a
  weapon `perkConstraint` by trying `lookup.perk(perkHash)` first (works for future hash-tagged plugs),
  then falling back to `lookup.perkByName(perkName)`. Candidate `BuildElement.tags` are populated the
  same way at generation time so the bound sees them too. **Corollary:** a plug with no name match
  contributes membership/pinning but zero synergy (correct — it has no keywords).
- **Membership pre-filter.** Before search, `slotToWeapons[slot]` is narrowed to weapons that can
  satisfy that slot's pins, reusing `columnsFor` / `PERK_COLUMN_CONFLICT` logic from `weapons.ts`
  (a pin whose only column already holds another pin ⇒ weapon excluded) and `perkToWeapons`. This is
  the "perk-roll membership" the slice is named for.
- **Column fill = terminal.** Every *unpinned* column of a chosen weapon gets exactly one plug at
  terminal (in-game weapons always carry a full roll); pinned columns are pre-filled. Maps onto SP3a's
  terminal-only completion routing. **One plug per column** (mutual exclusion by `socketIndex`) is
  enforced in candidate generation — a filled column offers no more plug candidates.
- **Joint beam over all open weapon slots.** Because synergy couples weapons across slots, all open
  weapon slots are open dimensions in the *one* beam (not independent per-slot solves) — the only way
  cross-slot roll combos surface.
- **Pinned weapons close their slot.** A `WeaponSelection` with `itemHash` already set is fixed; the
  solver fills only slots with `itemHash === undefined` and only *unpinned* columns of chosen weapons
  (mirrors how already-present fragments are treated in SP3a).
- **Output.** `solve` returns `RankedBuild`s whose `WeaponSelection`s have `itemHash` set and
  `perkConstraints` populated with the chosen plugs as `{perkHash, perkName, column}` (hash for
  identity/re-validation, name for synergy) — a directly usable, re-validatable deliverable.
- **Determinism.** Weapon-selection candidates and per-column plug candidates are hash-ordered
  (mirrors SP3a fragment/perk ordering); ties resolved by the same `priority || realized || key` rule.

## Module

Extend `src/lib/solver/` (same purity + DI rules as SP3a). New candidate-generation + expansion logic
for the weapons dimension; **no** change to `synergyUpperBound` (reused as-is). Two small out-of-solver
changes enable roll synergy (the name bridge): add `perkByName` to `Lookup` (`src/lib/validation/`) and
a name-resolution fallback in `collectBuildElements` (`src/lib/synergy/elements.ts`). May import from
`@/lib/validation` (`columnsFor`/weapon rules or their extracted helpers, `noDoublePrimary` logic) and
`@/lib/synergy`. Reaches synergy only through the SP1 seam. Layering stays one-way.

## Input / Output

```ts
// Unchanged signature — weapons participate through the existing Build + SolverContext.
solve(build: Build, ctx: SolverContext, options?: SolveOptions): SolveResult
```

- **Input:** a `Build` whose `weapons: WeaponSelection[]` may have some slots pinned (`itemHash` set)
  and/or carry pin `perkConstraints` (by hash or name). Open slots (`itemHash === undefined`) and
  unpinned columns are the search space.
- **Output:** `RankedBuild`s with each formerly-open `WeaponSelection` resolved to a concrete weapon +
  full roll (chosen plugs as `{perkHash, perkName, column}` in `perkConstraints`), ranked by
  `realized.score + statFit` as in SP3a.

## Search / candidate generation (staged)

1. **Env build (once):** for each open slot, membership-filter `slotToWeapons[slot]` by pins; drop
   weapons violating pin column-conflict; compute + cache the slot's **reachable-union** bound
   aggregate. If any open slot has zero legal weapons ⇒ `feasible: false` (mirrors SP3a's null-env).
2. **Weapon-selection candidates:** for an open slot, offer each surviving weapon as an addable
   element (`kind: "weapon"`, hash-ordered).
3. **Plug candidates (dependent):** once a weapon is chosen for a slot, offer one plug per *unpinned*
   column from `weapon.perkColumns[i].plugs` (`kind: "weaponPerk"`); a column already holding a plug
   (pinned or chosen) offers none.
4. **Eager ammo prune** in `expand`: reject any state whose fixed weapons already force double-Primary.
5. **Terminal:** every open slot has a weapon and every unpinned column of every chosen weapon has one
   plug.

## Test plan

- **Name bridge:** `lookup.perkByName` resolves a plug name to its tagged `Perk`; a
  **curated-resolution test** asserts a known trait set (Voltshot→`jolt`, Incandescent→`scorch`,
  Destabilizing Rounds→`volatile`, Repulsor Brace→`overshield`, Firefly→`precision_kill`) all resolve
  against real data, so season drift / empty-tag regressions fail loudly.
- **`collectBuildElements` fallback:** a weapon `perkConstraint` with a plug hash that misses
  `lookup.perk` but has a name resolving via `perkByName` contributes its tags to realized synergy.
- **Membership:** weapon excluded when a pin isn't in its pool (`PERK_NOT_IN_POOL` analog); two pins
  fighting one column exclude the weapon (`PERK_COLUMN_CONFLICT` analog).
- **Roll-for-synergy (the SP3a delayed-reward analog):** a slot where the synergy-optimal plug is not
  the lexically-first; bound ON keeps it, zero bound does not.
- **One-plug-per-column** exclusivity; **pinned column** respected (solver never overrides a pin).
- **Ammo eager prune:** a two-Primary weapon combo is pruned before its rolls are expanded (assert via
  state count, not just terminal result).
- **Cross-slot combo:** a roll in slot A + a roll in slot B that only score together are both selected
  (proves the joint beam, not per-slot greedy).
- **Cost ceiling (makes "too expensive" a number):** integration test on real data asserts a
  states-explored / timing ceiling under the loose bound — the trigger for the deferred tightened
  bound if it ever trips.
- **Feasibility:** zero-legal-weapon slot ⇒ `feasible: false`, empty builds.
- Full green gate throughout (tsc + eslint + all tests), as in SP3a.

## Explicitly deferred (do NOT build in this slice)

- Exotic armor + mods dimension; solver-chosen artifact (across all 7) + aspects with **dynamic
  fragment caps** (SP3b slices 2–3).
- Infeasibility **explanation** (still just a `feasible` boolean; diagnosis is a later slice).
- The **tightened per-slot bound** (deferred optimization, above).
- **Option A — hash-tagging weapon plugs at ingest** (`transform.ts`): the proper root-cause fix, folded
  into the next legitimate re-ingest, NOT triggered now (full manifest re-fetch = unrelated churn + OOM
  risk). Tracked in `docs/HANDOFF.md`. Until then the name bridge (Option B) is the synergy path.
- SP4 armor stat optimizer (`statFit` stays the injected stub).
