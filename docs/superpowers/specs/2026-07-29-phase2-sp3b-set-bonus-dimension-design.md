# Phase 2 · SP3b — The set-bonus dimension

**Status:** design approved 2026-07-29, ready for an implementation plan.
**Predecessor:** slice 2c (mods) — complete on `main`; UI name resolution `f28b9e6`.
**Baseline to preserve:** 424/424 tests (53 files), `tsc --noEmit` clean, `eslint scripts src tests`
clean, `npx next build` clean.

## Why this dimension

58 of the dataset's 112 set bonuses carry keyword tags, and nothing consumes any of them. They are
the last large body of tagged, buildcraft-relevant signal the solver cannot see — "Wrecker" gives
overshield plus stasis crystals at 2 pieces; "Ascendant Escape" gives invisibility at 4. A synergy
engine that ignores them is blind to a whole layer of real builds.

It is also the one dimension that has been blocked on a design question rather than on data:
`setBonusCounts` rejects every set bonus the solver writes. That is resolved here by a field split,
not by weakening the rule.

## The blocker, precisely

`setBonusCounts` (`src/lib/validation/armor.ts`) validates each `armor.setBonuses` entry against how
many pieces of that set appear in `armor.pieces`. The solver never writes `pieces` — that is SP4's
job — so a prescribed bonus written to `setBonuses` emits `SET_COUNT_INVALID` on **every** build.

The two claims are genuinely different:

| Field | Claim | Counted from |
| --- | --- | --- |
| `armor.setBonuses` | these bonuses are **ACTIVE** | the equipped `armor.pieces` |
| `armor.targetedSetBonuses` | these bonuses are **TARGETED** | nothing — it is a goal, not a state |

**Decision (user, 2026-07-29): add the separate targeted field. Do NOT relax `setBonusCounts`.**
Relaxing the rule when `pieces` is empty was rejected: it would make the rule silently
non-enforcing exactly when a build is solver-generated, which is the same class of mistake as the
`pieces` ∪ `exoticHash` gap recorded in `docs/HANDOFF.md`.

## Measured data

Manifest `244213.26.06.29.2000-1-bnet.65583`, already in `data/`. No re-ingest.

| Signal | Measured |
| --- | --- |
| Armour sets | **56** |
| Bonuses per set | **exactly one 2-piece + one 4-piece**, all 56 sets (shape `2/4`, no exceptions) |
| Bonuses total | **112**, with **112 distinct** `sandboxPerkHash`, **112/112** resolving in `perks.json` |
| Tagged bonuses | **58** — 29 two-piece, 29 four-piece |
| Sets by tagging | 18 both tagged · 11 only 2-piece · 11 only 4-piece · 16 neither (⇒ 40 with ≥1) |
| Set items | **840** = 56 sets × 3 classes × 5 slots; **840/840** resolve; **840/840** are Armor 3.0 |
| Set-item tier | **840/840 legendary**; 0 carry `exoticPerkHash` |
| Slot coverage | **exactly 5 distinct slots per (set, class) — 168/168 pairs** |

⚠️ Tags live on each **BONUS**, not on the set. Checking the set level shows 0/56 and is what
produced an earlier wrong note in the handoff.

The slot-coverage row is load-bearing twice over: it is why no achievability rule is needed, and it
is why the selector socket is inert (below).

## Game mechanic (user-confirmed, 2026-07-29)

**Thresholds are CUMULATIVE.** Four pieces of a set fire both its 2-piece and its 4-piece bonus. So:

- A decision is a **(set, threshold)** pair, not a bonus.
- A 4-piece target contributes **two** tagged elements to synergy, not one.
- The arithmetic is *max threshold per set, summed across sets* ≤ 4 — not the sum of every
  targeted bonus's `requiredCount`. `{A:2, A:4}` is not a thing; it **is** `{A:4}`.

This is a balance/mechanics fact rather than manifest structure, which is why it was confirmed with
the user rather than assumed. See `docs/HANDOFF.md` on user-supplied domain facts.

## The plan space, complete

Five armour slots minus one exotic leaves **4** legendary slots. The entire legal space:

```
∅          {A:2}          {A:4}          {A:2, B:2}   where A ≠ B
```

`{A:4, B:2}` needs 6 pieces. Nothing else exists.

**Candidates are therefore exactly one move per tagged bonus — the measured 58:**

- admit `(S, 2)` iff S's 2-piece bonus is tagged → 29
- admit `(S, 4)` iff S's 4-piece bonus is tagged → 29

The 11 sets whose 2-piece alone is tagged never offer `(S,4)`: spending 4 pieces to activate exactly
the tags 2 pieces already buy is strictly dominated while there is no stat model. Untagged bonuses
are excluded entirely — unlike an aspect (which grants fragment slots) or a weapon (which fills a
required slot), an untagged set bonus can do nothing at all, so admitting it would only breed
identical-scoring states.

⚠️ **Revisit both exclusions when SP4 lands.** Once stats matter, a 4-piece plan constrains which
pieces the build can use, so `(S,4)` with only a tagged 2-piece stops being dominated and an
untagged bonus stops being inert.

### Why 54 of 112 bonuses are untagged — measured, not assumed

Checked at the user's prompting, since "every set has a 4-piece bonus" and "29 of 56 four-piece
bonuses are tagged" can look like the same claim contradicting itself. They are not: **all 56 sets do
have a 4-piece bonus**; what varies is whether our keyword scanner finds anything in it.

The 54 untagged bonuses (27 two-piece, 27 four-piece) all have non-empty descriptions. Their effects
are outside the synergy keyword model **by design**:

| Effect present in untagged bonuses | Bonuses |
| --- | --- |
| weapon handling / stability / reload / aim assist | 15 |
| flinch resistance | 8 |
| damage resistance or reduction | 7 |
| healing not named `cure` / `restoration` | 7 |
| special ammo | 2 |
| super energy | 1 |

These are stat and survivability effects with no keyword for a synergy graph to chain through, so
excluding them from the pool costs nothing. Examples: `Per Audacia · Sublime Transit` ("increases
mobility and grants enhanced sprint speed and slide distance"), `Crota's Memory · Power of the Son`
(progressive flinch and damage resistance).

### ⏭️ FOLLOW-UP found here, deliberately OUT OF SCOPE: two missing vocabulary entries

`KEYWORD_VOCABULARY` + `TRIGGER_VOCABULARY` (`scripts/ingest/keywords.ts`) total **33 entries** and
omit two real buildcrafting currencies:

| Missing keyword | Untagged set bonuses | Untagged **perks** |
| --- | --- | --- |
| `void_breach` | 2 | **26** |
| `armor_charge` | 2 | **56** |

The gap is **systemic, not set-specific** — Armor Charge is a major currency the whole engine is
currently blind to. Adding both would tag only 4 of the 54 untagged bonuses, so it does not change
this design: the pool is DERIVED from tags rather than hardcoded, so it would widen from 58 on its
own after a re-ingest, with no code change here.

Out of scope because it is an ingest/vocabulary change requiring a re-ingest and affecting every
dimension. It should be scheduled on its own, with the mutation-and-floor discipline the ingest
repair established.

## Scope

**In scope**

- `ArmorLoadout.targetedSetBonuses?: TargetedSetBonus[]` where `TargetedSetBonus = { setHash, pieceCount }`.
- The solver chooses targets: one open dimension, add-one-target moves, ≤2 extra beam levels.
- Set bonuses enter synergy through `collectBuildElements`.
- A validator rule for the new field + a new `ViolationCode`.
- `resolveSolverEnv` rejects a **pinned** illegal plan instead of extending it.
- One `BuildDisplay` field and one page row, so the UI shows what was targeted.

**Out of scope, deliberately**

| Excluded | Why / owner |
| --- | --- |
| `armor.pieces` — which actual pieces to wear | SP4; prescription targets a set + threshold |
| Stat consequences of targeting | SP4 (armour stats are not ingested at all yet) |
| `armor.setBonuses` semantics or `setBonusCounts` | unchanged, deliberately |
| A set-bonus wildcard / selector mechanic | does not exist — see the correction below |

## Corrections to `docs/HANDOFF.md`

Both recorded here so the next session does not re-derive them.

**1. There is no set-bonus wildcard mechanic (user, authoritative, 2026-07-29).** The handoff warned
that ignoring a "set-bonus SELECTOR socket" would over-report infeasibility, reading DIM's
`hasSetBonusModSocket` as a piece that can substitute for a missing set piece. Per the user, no such
wildcard exists. Nothing is modelled and no limitation needs stating.

**2. The handoff calls the selector-socket items "3 exotic class items". They are LEGENDARY.**
Measured — `Raptor's Bond` (warlock), `Viperous Cloak` (hunter), `Panthera Leo Mark` (titan), all
`tier: legendary`, all in the `class` slot, category
`core.gear_systems.event_gear.item_sets.selectors`. The distinction mattered: "exotic" implied the
socket sat in the exotic slot and so added set-piece *capacity*. It does not. Even if a wildcard
existed, a legendary class item consumes the same legendary slot the real set piece would, so it
could not enlarge the plan space — and with all 56 sets covering all 5 slots for all 3 classes,
there is never a missing piece to substitute for.

**3. Parked, unverified, no bearing on this work:** those 3 items carry **no `setHash`** in our data,
though the user suspects they do belong to a set. If so, the ingest is missing their set membership.
It cannot affect this dimension — prescription names a set and a threshold, never specific pieces,
and every set already has a class item for every class.

## Architecture

### New module `src/lib/solver/set-bonuses.ts`

Mirrors `armor.ts` and `subclass.ts`.

| Export | Contract |
| --- | --- |
| `SET_PIECE_BUDGET = 4` | 5 slots − 1 exotic |
| `deriveSetBonusPool(ctx)` | the 58 options, sorted by `(setHash, pieceCount)` for determinism |
| `deriveSetBonusReach(pool, ctx)` | tagged reachable bonuses as `BuildElement[]` |
| `remainingPieceBudget(targets)` | `SET_PIECE_BUDGET − Σ pieceCount` |

`TargetedSetBonus` lives in `src/lib/types/build.ts` beside `ActiveSetBonus`, and this module does
**not** re-export it — the build model owns build-model types.

**⚠️ The pool is CLASS-INDEPENDENT, unlike every other pool in the solver.** All 56 sets cover all 3
classes, so there is nothing to filter on and the dimension is open for any build — including an
element-only pin, where the exotic and aspect dimensions are closed. Consequences, both real:

- Byte-compatibility rests **only** on the empty-`|set:`-segment rule and on the pool being empty
  when `chooseSetBonuses` is false. There is no natural "no class ⇒ closed" fallback as there is for
  exotics and aspects.
- Enabling the dimension by default **changes the output of every existing solve** (more tagged
  elements ⇒ higher top scores), so any test asserting an exact score or an exact top build changes
  with it. See the default-on decision below.

**The budget is the constant 4 even when no exotic is chosen.** With the exotic dimension closed
there are 5 legendary slots, but no legal plan costs 3 or 5 — the only combination that could use a
5th piece is `{A:4, B:2}` at 6 — so the reachable plan space is identical and a state-dependent
budget would buy nothing. This proof belongs in the code comment, because "5 slots but budget 4"
otherwise reads as an off-by-one.

### Beam wiring — additive, exactly as slices 1, 2b and 2c were

- `SolverEnv.setBonusPool: TargetedSetBonus[]` — **empty ⇔ dimension closed**, the established contract.
- `Selection.setBonusTargets: TargetedSetBonus[]` — required, empty when closed, matching
  `mods: ModPick[]`. Carries the solver's OWN picks only; `makeState` concatenates pinned + chosen
  when writing the build, as it does for aspects.
- A `setBonus` candidate kind in `candidates.ts`, emitted for each pool option whose `pieceCount`
  fits the remaining budget and whose set is not already targeted.
- An `expand` branch that spreads `{ ...sel }` and appends, keeping targets sorted by
  `(setHash, pieceCount)` so `{A,B}` and `{B,A}` collapse to one state.
- `stateKey` appends a `|set:` segment **only when non-empty**, so every key written before this
  dimension existed stays byte-identical.

### Synergy entry

`collectBuildElements` gains one loop: for each target, take
`lookup.armorSet(setHash).bonuses.filter(b => b.requiredCount <= pieceCount)` and add one element
per bonus, keyed by `sandboxPerkHash` with `source: "set-bonus:<name>"` and **`bonus.tags`** — the
set-specific ingested tagging, not the resolved sandbox perk's own tags.

All 112 `sandboxPerkHash` values are distinct, so hash identity is clean and the existing `seen`
dedup needs no special case. Synergy does not import the solver; the filter is three lines against
`Lookup`, exactly how every other entity family is handled there.

### ⚠️ The reach trap — do NOT dedup reach by tag signature

Slice 2c cut mod-reach cost by deduping reach elements with identical tag signatures (126 → 32
elements). **That transformation is unsound here.** At most two bonuses activate, but two
*different* sets can both produce the same keyword, so collapsing identical signatures would
under-count producers and make the bound **under-estimate** — inadmissible. Reach stays the full
58-element union, which is a superset of any completion's contribution and therefore admissible.

There is no cost pressure to justify the risk: this dimension is 2 levels deep and ≤58 wide.

### Why add-one-target rather than one-shot plan selection

A single move picking a whole plan from the 464 tagged plans (29 + C(29,2) + 29) needs only one beam
level, which is tempting given slice 2c's finding that cost is depth-driven. But that finding says
narrowing width cannot **rescue** a deep dimension — not that width is free. Estimated bound calls
added, at `beamWidth` 16:

| Approach | Levels | Successors | ≈ added bound calls |
| --- | --- | --- | --- |
| **add-one-target (chosen)** | ≤2 | 58 then ≤28 | **~1,400** |
| one-shot plan | 1 | 464 | ~7,400 |
| greedy post-pass | 0 | — | 0, but not jointly optimised |

The post-pass is rejected on substance rather than cost: the bonus could not influence which exotic,
aspects or fragments are chosen, and cross-dimension synergy coupling is the product.

## Terminal routing

**No `dimensionsAllDecided` clause** — the same call slice 2c made for mods, for the same reason.
Set bonuses are optional: five pieces from five different sets is a legal build. Underfill is
therefore legal, a state that can add no further target is **maximal rather than incomplete**, and
because a tagged bonus has no downside today, maximal is optimal — so terminal-only routing holds
without best-partial tracking.

⚠️ **SP4 breaks that argument.** Once targeting constrains which pieces (and so which stats) a build
can have, a target *does* have a downside, and this needs revisiting alongside the two dominance
exclusions above.

## Validation and error handling

**New rule `targetedSetBonusPlan`** in `src/lib/validation/armor.ts`, added to `ALL_RULES`, new
`ViolationCode` **`SET_TARGET_INVALID`**, emitted when:

- a `setHash` does not resolve via `lookup.armorSet`
- `pieceCount ∉ {2, 4}`
- two targets name the same set
- `Σ pieceCount > 4`

`setBonusCounts` is **not modified**. A build carrying only targets and no `pieces` must produce
zero `game` violations.

**No achievability rule**, and the measurement is the justification: every (set, class) pair covers
all 5 slots (168/168), so a targeted set is always obtainable by any class. Recorded so a future
reader does not add a rule that can never fire.

**New infeasibility code `SET_TARGET_PLAN_ILLEGAL`** for a **pinned** plan that fails any of the four
conditions above. `resolveSolverEnv` reports it rather than silently extending the plan — a
silently-ignored bad pin is precisely the defect slice 4 closed with
`EXOTIC_PIN_CONTRADICTS_PINNED_PIECE`. Causes accumulate rather than short-circuit, per slice 4's
contract. Nothing can pin a plan through the UI yet; this exists so the seam is honest when
something can.

## UI

`BuildDisplay` gains **`setBonusNames: string[]`** — one entry per TARGET, formatted
`"<set name> · <pieceCount> pieces"` — and `page.tsx` gains one `Set bonuses` row rendering them
joined, `"—"` when empty. The target is what gets displayed rather than the activated bonus names,
because the target is the actionable prescription ("go obtain 4 pieces of this set") while the
activated perks are its consequence.

Built on the seam from `f28b9e6`. Without it the page silently hides a decision the solver made.
Names resolve through `Lookup.armorSet`, and the existing negative assertion (no displayed value
matches `/^\d{4,}$/`) covers the new field automatically because it flattens
`Object.values(display)`.

## Tests that prove it done

1. **The field split works.** A solver-produced build carrying a target passes `validateBuild` with
   **zero `game` violations**, specifically no `SET_COUNT_INVALID`. This is the assertion that fails
   today if the bonus is written to `setBonuses`.
2. **Arithmetic on the PLAN, not on feasibility.** Over every top-N build for arc/warlock,
   solar/titan and stasis/hunter: sets distinct, `pieceCount ∈ {2,4}`, `Σ ≤ 4`, and a 4-piece plan
   never combined with another target.
3. **Admissibility property test, SYNTHETIC.** A fixture where the only producer of a pinned
   fragment's consumed keyword is a set bonus, asserting the bound on a target-undecided state
   dominates every completion's realized score. **Mutation-proven:** deleting the reach push must
   redden it. Synthetic because slice 2c's real-data admissibility gate passed with the reach term
   deleted — real data lets other dimensions' reach dominate.
   Per the slice-2b rule, this dimension is multi-move but **single-stage** (a target's reward is
   realized immediately, not behind a stage boundary), so an admissibility property test is the
   right gate and an outcome gate would likely pass vacuously.
4. **Weapons tripwire still exactly 10,527** bound calls — proof the slice is additive.
5. **Cumulative activation, directly.** `(S,4)` yields two `BuildElement`s and `(S,2)` yields one,
   on a synthetic set. This is the user-confirmed mechanic, so it earns its own test rather than
   being implied by integration results.
6. **Pool bounded on BOTH sides** (≈58; over-inclusion must fail too), following slice 2c's
   `≥40, <120` precedent for mods.
7. **Byte-compatibility.** State keys identical to today when the dimension is closed.
8. **Marginal cost factor measured and recorded**, alongside 2.72× (exotic), 1.21× (aspect) and
   5.37× (mods).

## The default-on decision

The flag `SolveOptions.chooseSetBonuses` is built either way. Its **default is set from
measurement**, not from a guess made now. Two gates, and it ships on only if BOTH pass:

1. the marginal cost factor is ≲2.5× (the exotic dimension ships on at 2.72×), and
2. the churn in existing test expectations is small and reviewable — because the pool is
   class-independent, default-on raises the top score of *every* existing solve, so this is a
   review-burden question, not just a cost question.

If either gate fails it ships opt-in (default `false`), like mods. Recording the rule here means the
measurement decides it and the reasoning survives either way.

## Open questions

None blocking. Deliberate deferrals recorded above:

- The dominance exclusions and the terminal-routing argument both need revisiting when **SP4** lands.
- **`void_breach` and `armor_charge` are missing from the keyword vocabulary** (26 and 56 untagged
  perks respectively). Needs its own scheduled slice and a re-ingest; widens this pool for free when
  it happens.
- The missing `setHash` on the three event class items is parked as unverified, with no bearing on
  this work.
