# Phase 2 · SP1 — Synergy Engine v1 (design spec)

> Fills the inert `getSynergies` / `scoreSynergy` seam with a rules-based synergy
> engine over the ingested keyword-tag substrate, and adds a small set of soft
> `policy` advisories. First sub-project of Phase 2. Depends only on the Phase 1
> validator + the existing dataset; independent of the (later) solver and
> artifact-model rework.

## 1. Context & goal

Phase 1 shipped a hard-rule feasibility validator. The design's core value is
"specify constraints → validate feasibility → **suggest synergies** → explain
*why* the pieces work together." This sub-project delivers the synergy half.

The **substrate is already in the dataset**: every entity carries `KeywordTags`
(`produces` / `consumes` / `triggers` / `element`), and `data/indexes.json`
holds a `KeywordIndex` (producers/consumers per keyword). Coverage on the
synergy-driving entities is good (aspects 58/81, fragments 73/95, perks
1179/3836, mods 145/512, artifact perks 192/294). Weapons are sparsely tagged
(14/2208) — acceptable, because weapons are not primary synergy drivers; they
contribute mainly `element` for coherence.

**Goal:** a pure, dependency-injected engine that, given a (partial) `Build`,
returns the synergies present with a human-readable *why* and an aggregate
score, plus a few advisory `policy` violations for clear gaps. No filesystem in
the engine — it reaches data through the `Lookup` seam, like the validator.

**Non-goals (deferred):** the completion/beam-search solver (SP3); the artifact
build-model rework (SP2); authoring a large curated overlay (mechanism only
here); graph-embedding ML (Phase 3); OAuth per-account unlock state.

## 2. The scoring model

**Invariant:** `score == Σ (weight of each listed synergy)`. Every point of
score is backed by a listed `Synergy` with a `why`. Multiplicativity (below)
lives *inside* each synergy's weight, never as a hidden aggregate term.

### Signal 1 — Producer→consumer chains (primary), depth-weighted

Builds are *engines*: you want to loop one (or a few) keywords
(produce → consume → produce), not spread shallowly across many. The score
rewards this super-linearly.

For each keyword `K`:
- Let `p` = number of build elements that **produce** `K`, `c` = number that
  **consume** `K`. The loop's **depth** is `d = min(p, c)` — a chain is only as
  strong as its weaker side.
- Pair producers with consumers into matched chains. The **i-th matched
  chain (rank i = 1, 2, 3, …) is weighted `CHAIN_BASE · i`** (escalating), so a
  depth-`d` engine in one keyword totals `1+2+…+d = d(d+1)/2` — **quadratic in
  depth**. This is the multiplicative "focus" reward.
  - Worked example: a Volatile engine with 3 producers + 3 consumers scores
    `1+2+3 = 6`; a scattered build with one producer+consumer across three
    *different* keywords scores `1+1+1 = 3`. Same six elements, focus wins —
    and wins harder as depth grows.
- Each matched chain is a `Synergy { fromHash: producer, toHash: consumer,
  via: K, weight, why }`. `why` names both sources and the escalation, e.g.
  *"3rd Volatile link — deepening your Volatile engine (×3)."*
- **Matching algorithm (deterministic, self-pair-safe):** let `P` = the build
  elements producing `K` and `C` = those consuming `K`, each sorted by hash
  ascending. Walk `P` in order; for each producer, pair it with the
  lowest-hash **not-yet-used consumer that is a *different element*** (an
  element that both produces and consumes `K` — the text-scan artifact — is thus
  never paired with itself, and cross-chains with other elements are preserved).
  Each successful pairing is the next rank (1, 2, 3, …), weight
  `CHAIN_BASE · rank`. Stop when `P` or the available consumers are exhausted.
  The number of chains formed is the effective **depth `d` ≤ min(|P|, |C|)**;
  the leftover unpaired producers / consumers feed the advisories in §3 (single
  source of truth). Greedy hash-ordered pairing keeps output stable across runs
  and testable without depending on collection order.
- **Artifact/set reinforcement falls out for free:** artifact perks, set
  bonuses, mods, fragments, and aspects all participate as elements, so a set
  bonus or artifact perk that produces/consumes an in-play keyword is just
  another producer/consumer — no separate mechanism.

### Signal 2 — Element coherence (a multiplier, not a separate term)

A matched chain whose **producer and consumer both align with the build's
subclass element** is scaled by `ELEMENT_ALIGNED_MULT`. Rewards element-coherent
builds without inventing non-pairwise score. Pure same-element with no keyword
interaction earns nothing (no independent mechanical payoff).
- "Aligns with the build's subclass element" = the element's `tags.element`
  equals `build.subclass.element`, OR is `"prismatic"` (prismatic slots into any
  element focus). If `build.subclass.element` is undefined, the multiplier is not
  applied (nothing to cohere around yet).

### Signal 3 — Trigger alignment (secondary, capped)

Elements sharing a `trigger` (e.g. two effects both keyed on `grenade`)
reinforce a focused build. Emit lower-weight `Synergy { fromHash, toHash,
via: "trigger:<t>", weight: TRIGGER_SHARE, why }` for pairs sharing trigger `t`.
- **Capped:** at most `TRIGGER_GROUP_CAP` pairs contributed per trigger group,
  taking the lowest-hash elements first (deterministic), to avoid an all-pairs
  blowup on popular triggers. Self-pairs excluded.

### Signal 4 — Curated overlay

`weights.ts` loads a hand-authored JSON overlay (near-empty in v1) of known
combos the keyword scan misses:
`{ fromHash?, toHash?, via, weight, why }`. Each entry present in the build
becomes an additional listed `Synergy`. An entry applies when its referenced
hashes (when given) are present among the build's collected elements. This is
the escape hatch for nuance the automatic layer can't derive; authoring real
entries is ongoing work outside this sub-project.

### Weights (named constants, one module)

In `src/lib/synergy/weights.ts`, trivially tunable; starting values:
`CHAIN_BASE = 1.0`, `ELEMENT_ALIGNED_MULT = 1.5`, `TRIGGER_SHARE = 0.5`,
`TRIGGER_GROUP_CAP = 3`. Tuned against real builds later.

## 3. Policy advisories

Soft, non-invalidating feedback surfaced through the validator's `Rule` seam.

- **Two new `ViolationCode`s** (added to the union in
  `src/lib/validation/types.ts`, the shared vocabulary): `UNUSED_PRODUCER`
  ("you create `K` but nothing in the build consumes it") and `UNMET_CONSUMER`
  ("you rely on `K` but nothing produces it"). Both `category: "policy"` →
  `validateBuild`'s `valid` (which checks only `game`) stays true.
- **`synergyRules: Rule[]`** (in `src/lib/synergy/rules.ts`) compute these from
  the **same** `collectBuildElements` list + the **same §2 matching** used by
  the scorer, so the *leftover unpaired* elements after matching are exactly
  what these flag — one source of truth.
  - After matching keyword `K`: any producer left unpaired → emit one
    `UNUSED_PRODUCER` for `K`; any consumer left unpaired → emit one
    `UNMET_CONSUMER` for `K`. At most one advisory of each kind per keyword,
    regardless of how many elements are left over (the subject names the
    keyword, not each element).
- **Partial-build safe by construction:** an advisory fires only when a
  producer (or consumer) for `K` is present with no counterpart; an empty or
  single-element build produces none.

## 4. Architecture & interfaces

**Access seam — extend `Lookup`.** Scoring resolves every build element to its
`KeywordTags`. The Phase 1 `Lookup` resolves weapon/armor/aspect/fragment/
subclass/artifact but not perks or mods (which carry the richest tags). Extend
`Lookup` (in `src/lib/validation/types.ts`) and `createLookup` (in
`src/lib/validation/lookup.ts`) with:
- `perk(hash): Perk | undefined`
- `mod(hash): Mod | undefined`
- `artifactPerk(hash): ArtifactPerk | undefined` — flattened across all
  artifacts' tiers, for resolving `selectedPerkHashes`.

**Signature change.** `getSynergies(build, lookup)` /
`scoreSynergy(build, lookup)` (was `(build)`). This is the seam the future
solver calls; adding `lookup` is consistent with the validator and preserves
the ML-swap boundary.

**Shared element collector.** `collectBuildElements(build, lookup)` resolves a
`Build` into a flat list of tagged elements
`{ hash, source, tags }`, where `source` is a label like
`"fragment:Facet of Bravery"` driving the "why". Participating elements in v1:
- subclass: `element` (for coherence) + each aspect + each fragment;
- armor: `exoticHash` + each `modHashes` entry;
- artifact: each `selectedPerkHashes` entry (via `artifactPerk`);
- weapons: each `itemHash` (element) + each **resolved `perkHash`** constraint
  (name-only constraints are skipped in v1 — no roll resolution yet).

Both the scorer and `synergyRules` consume this one list, so they can never
disagree about what's in the build.

**Self-pair handling.** Producer→consumer and trigger matching exclude the same
element paired with itself (the produce+consume-same-keyword text-scan
artifact), so an item that mentions "restoration" doesn't synergize with itself.
Matching is by element identity (position in the collected list), not by hash,
so two *distinct* elements that happen to share a hash are not falsely merged.

**Module layout** under `src/lib/synergy/`:
- `elements.ts` — `collectBuildElements` + `BuildElement` type
- `graph.ts` — pairwise producer→consumer matching, element/trigger signals
- `weights.ts` — weight constants + curated-overlay loader
- `score.ts` — `getSynergies` / `scoreSynergy` aggregation
- `rules.ts` — `synergyRules: Rule[]` (policy advisories)
- `index.ts` — public re-exports; keeps existing `Synergy` / `SynergyScore`
  types; exports convenience `allRules = [...ALL_RULES, ...synergyRules]`

**Layering.** The synergy layer depends on the validation layer, never the
reverse. `synergyRules` and `allRules` live in `synergy/`; validation's
`ALL_RULES` stays hard-only. (The two new `policy` codes live in the shared
`ViolationCode` union in validation/types — that union is the canonical Violation
vocabulary, not synergy logic.)

## 5. Testing

- **Unit tests** with injected stub lookups (no filesystem), mirroring the
  Phase 1 validation tests:
  - chain detection + "why" text;
  - escalating depth weights (a depth-2 Volatile engine scores `1+2 = 3`);
  - element-alignment multiplier applies only on subclass-element match /
    prismatic, and not when subclass element is unset;
  - trigger-share cap enforced; self-pair exclusion;
  - the `score == Σ weights` invariant;
  - surplus → `UNUSED_PRODUCER` / `UNMET_CONSUMER` with correct keyword subject,
    and both `category: "policy"` so `valid` stays true;
  - empty build → no synergies, no advisories;
  - a curated-overlay entry present in the build adds a listed synergy.
- **One integration test** (`describe.runIf(hasDataset)`) against the real
  dataset: assemble a real Void-volatile-style build from actual hashes, assert
  `scoreSynergy` > 0 with a coherent top "why", and that surplus advisories
  behave. Same pattern as the Phase 1 integration test.

## 6. Success criteria

- `getSynergies` / `scoreSynergy` return real results over the `Lookup` seam;
  signature updated; solver seam intact.
- All four signals implemented; `score == Σ weights` holds in tests.
- `synergyRules` emit the two `policy` advisories; `valid` never flips on them.
- `Lookup` extended with `perk` / `mod` / `artifactPerk`; `createLookup` updated;
  existing Phase 1 tests stay green.
- Unit + integration tests pass; `tsc` and `eslint` clean.

## 7. Open follow-ups (out of scope here)

- Author real curated-overlay entries (ongoing).
- Weapon roll resolution for name-only perk constraints (needs solver-side roll
  logic; SP3).
- Tune weights against a corpus of real builds.
- SP2 (artifact model rework) and SP3 (solver) proceed separately.
