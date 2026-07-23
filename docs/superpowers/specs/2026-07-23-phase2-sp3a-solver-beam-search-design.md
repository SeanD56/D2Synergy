# Phase 2 · SP3a — Solver core + beam search (fragments + artifact) — design

> Validated design. Consumes: SP1 synergy engine, SP2 artifact capacity oracle (both shipped to `main`).
> First slice of SP3 (the completion / beam-search solver). Flow: brainstorming (this doc) →
> writing-plans → subagent-driven-development (same as SP1/SP2).

## Why a slice, and why THIS slice

SP3 (the whole solver) is large and carries one dominant technical risk: **beam search prunes partial
builds by score-so-far, but synergy is cross-dimensional and pairwise** — a fragment that *produces*
"volatile" scores as dead weight (an `UNUSED_PRODUCER`) until a perk that *consumes* "volatile" is
also chosen. A naive beam prunes exactly the producer that would have been excellent once its consumer
arrives. This "delayed-reward" problem is the crux of the design.

Decision (user-confirmed): **do a thin vertical slice first, chosen to expose the risk.** Not two
independent dimensions (proves only plumbing), not a single dimension (cross-dimension synergy never
appears). The slice is **subclass fragments + artifact perks** — both feed producer/consumer keywords,
so the beam is *forced* to solve delayed reward on a small surface. Whatever partial-scoring approach
proves out here is what SP3b scales to the remaining dimensions.

Second reality that shaped scope: the design's ranking objective is *stat-fit + synergy*, but stat-fit
comes from the armor optimizer = **SP4 (not built, explicitly delayable)**. So SP3a can only rank by
synergy plus a **stubbed/pluggable** stat term. The "full completer" is partly gated on SP4 anyway.

## Scope

**In SP3a:** solver interface; candidate generation for fragments + artifact perks; a unified
beam-search engine with optimistic-completion-bound partial scoring; synergy ranking; a stubbed
stat-fit seam.

**Deferred to SP3b (do NOT build now):** weapons dimension (perk-roll *membership* candidate-gen — a
genuinely different pattern), exotic armor, mods; solver-chosen artifact (across all 7) and
solver-chosen aspects (dynamic fragment cap); the full infeasibility **explanation** (SP3a returns
only a `feasible` boolean, not a diagnosis).

**Deferred to SP4:** the armor stat optimizer (DIM port, web worker) — SP3a defines the seam only.

## Module

New `src/lib/solver/` — **pure, dependency-injected**. May import from `@/lib/validation`
(`validateBuild`, `evaluateArtifactCapacity`, `canAddArtifactPerk`), `@/lib/synergy`
(`scoreSynergy`, `getSynergies`), and `@/lib/types`. It reaches synergy **only** through the SP1 seam
(never knows rules vs. embeddings sit underneath — keeps the Phase-3 ML layer drop-in). No filesystem;
all data access via injected `Lookup` + `Indexes`. Layering one-way: nothing in validation/synergy
imports solver.

## Input / Output

```ts
solve(build: Build, ctx: SolverContext, options?: SolveOptions): SolveResult

interface SolverContext {
  lookup: Lookup;      // @/lib/validation seam (entity resolution + artifactPerk, etc.)
  indexes: Indexes;    // precomputed inverted indexes (keyword, etc.) from the dataset
}
interface SolveOptions {
  beamWidth?: number;  // default W = 16
  topN?: number;       // default N = 5
}

interface SolveResult {
  builds: RankedBuild[];   // top-N completed builds, best first
  feasible: boolean;       // false if the pinned inputs admit no completion at all
}
interface RankedBuild {
  build: Build;            // fully completed: fragment set + artifact perk set filled
  score: number;           // total = synergy.score + statFit
  synergy: SynergyScore;   // the "why" breakdown (from getSynergies)
  statFit: number;         // from the stubbed seam (0 in v1)
}
```

**Input contract (SP3a):** `build.subclass` has `element` + `aspectHashes` pinned (this fixes the
fragment-slot cap); `build.artifact.artifactHash` is pinned (this fixes the perk pool). Fragments
(`build.subclass.fragmentHashes`) and artifact perks (`build.artifact.selectedPerkHashes`) are the two
OPEN dimensions the solver fills. Any fragments/perks already present are treated as pinned (kept).

## Beam search (the mechanism this slice proves)

- **State** = a partial `Build`. **Move** = add one fragment OR one artifact perk to an open dimension.
- **Candidate generation:**
  - Fragments: the pinned element's fragment pool (via dataset/indexes), minus already-chosen, only
    while under the aspect-granted slot cap.
  - Artifact perks: the pinned artifact's perk pool, each addition gated by `canAddArtifactPerk`
    (SP2 oracle) so an infeasible addition is never even generated.
- **Partial-build score (drives pruning)** = `realized(partial) + optimisticBound(partial)`:
  - `realized` = `scoreSynergy` of the partial build as-is.
  - `optimisticBound` = Σ, over each keyword the partial build produces-or-consumes but has left
    unmatched, of that keyword's **best-possible future chain link** — credited **only if** an OPEN
    dimension's candidate pool can still supply the complementary side (checked via the keyword index).
  - **Admissible:** the bound never underestimates the true best completion, so a promising producer
    is never pruned before its consumer can arrive.
- **Prune:** keep the top-`W` states by that score. Expand until no open dimension can accept another
  element (caps reached / oracle-infeasible / pool exhausted).
- **Final ranking:** completed states are ranked by **realized** `scoreSynergy.score + statFit`
  (NOT the bound). Return the top `N`.
- **Determinism:** candidates iterated by sorted hash; state ties broken by a stable build key
  (e.g. sorted selected hashes). Output identical regardless of input collection order.

## Stat-fit seam

```ts
interface StatFit { (build: Build, ctx: SolverContext): number }
export const neutralStatFit: StatFit = () => 0;   // v1 stub
```
The solver takes a `StatFit` (default `neutralStatFit`). SP4 replaces it with the armor-optimizer
result without touching the solver. In v1, ranking is effectively synergy-only.

## Testing

- **Unit:**
  - Candidate-gen respects the fragment-slot cap and the artifact oracle (`canAddArtifactPerk`);
    already-present fragments/perks are kept, not duplicated.
  - The optimistic bound is a genuine **upper bound**: on synthetic pools, `realized(partial) +
    bound(partial) >= scoreSynergy(anyReachableCompletion)` for all completions. (Proves admissibility.)
  - **Delayed-reward property (the point of the slice):** a producer fragment whose ONLY consumer is
    an artifact perk survives the beam and appears in the top-ranked build — a naive realized-only beam
    would prune it. This test must fail if the bound were removed.
  - Determinism: identical `SolveResult` across permuted input/candidate order.
- **Integration (real dataset):** a coupled fragment/perk pair ranks above an uncoupled selection;
  top build carries a non-empty `synergy.synergies[].why`. `feasible` true for a fillable pinned input.

## Decisions log

- **Slice = fragments + artifact perks**, chosen because both feed producer/consumer keywords and thus
  force the beam to solve cross-dimension (delayed-reward) synergy. *Why:* derisk the one design choice
  most likely to force a redesign, before scaling to all dimensions in SP3b.
- **Partial scoring = optimistic completion bound (admissible upper bound).** *Why:* principled fix for
  delayed reward; never prunes a producer whose consumer could still come; it is the mechanism SP3b
  scales. Chosen over a crude tunable potential term and over reduce-then-join (which dodges partial
  scoring and doesn't prove beam pruning).
- **Pin subclass (element+aspects) + artifact; solver fills fragment set + perk set.** *Why:* fixes the
  fragment-slot cap and the perk pool, keeping the slice to exactly two open subset-dimensions.
  Solver-chosen artifact (7) and solver-chosen aspects (dynamic cap) are SP3b.
- **Ranking = synergy + stubbed stat-fit (0 in v1).** *Why:* stat-fit is SP4; define the seam now,
  fill it later, without reworking the solver.
- **Bound tightness is a tuning follow-up, not a correctness dependency.** *Why:* correctness needs
  only admissibility (never underestimate); a loose bound just widens the effective beam, which `W`
  absorbs. Tightening for efficiency comes later, measured against real builds.
- **Beam is a single "add-one-element" search across both open dimensions** (not per-dimension inner
  loops). *Why:* one unified mechanism naturally handles bounded subset-selection AND cross-dimension
  synergy, and is exactly the shape SP3b extends by adding more dimensions' candidate generators.
