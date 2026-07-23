# Phase 2 · SP3a — Solver core + beam search (fragments + artifact) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pure, dependency-injected `src/lib/solver/` module whose `solve()` completes a partially-pinned `Build` over two open dimensions (subclass fragments + artifact perks) with a unified beam search, pruning partial builds by an admissible optimistic synergy bound so a producer whose only consumer arrives later is never prematurely pruned.

**Architecture:** A single "add-one-element" beam search over two open subset-dimensions. Each state is a partial `Build`; a move adds one fragment (gated by the aspect-granted slot cap) or one artifact perk (gated by the SP2 capacity oracle). States are pruned by an **admissible upper bound** on the best synergy any completion could reach — computed by the synergy module itself (new `synergyUpperBound` export) so the bound co-varies with the scoring internals and the Phase-3 embedding layer stays drop-in. Completed (maximal) builds are ranked by *realized* `scoreSynergy.score + statFit`; stat-fit is a stubbed seam (`neutralStatFit → 0`) that SP4 fills.

**Tech Stack:** TypeScript (strict), Vitest, ESLint. No new dependencies. Consumes SP1 (`@/lib/synergy`) and SP2 (`@/lib/validation`).

## Global Constraints

- **Purity + DI:** the solver reads data ONLY through injected `ctx = { lookup, indexes }`. No filesystem, no dataset imports, no `Date.now()`/`Math.random()`.
- **Determinism:** identical `SolveResult` regardless of input/candidate collection order. Achieve via sort-by-hash on every pool and a stable build key (`frag:<sorted>|perk:<sorted>`) for all tie-breaks.
- **Synergy seam:** the solver reaches synergy ONLY through `@/lib/synergy` exports (`scoreSynergy`, `getSynergies`, and the new `synergyUpperBound`). It never imports synergy internals (`weights.ts`, `graph.ts`, `elements.ts`) nor the weight constants.
- **One-way layering:** nothing in `@/lib/validation` or `@/lib/synergy` imports `@/lib/solver`. (`synergyUpperBound` lives inside `@/lib/synergy` and imports only synergy-internal + `@/lib/types` + the `Lookup` *type* from `@/lib/validation/types` — the same imports the existing synergy files already use.)
- **`Indexes` type is the existing dataset one** from `@/lib/types` (`{ keyword, perkToWeapons, elementToItems, ... }`). Do NOT define a new `Indexes`.
- **Path alias:** `@/*` → `src/*` (works in `tsc` and vitest). Mirror the import grouping of existing files (`@/lib/types`, blank, `@/lib/validation`, blank, `@/lib/synergy`, blank, relative `./`).
- **Green gates before every commit:** `pnpm test -- run` (the touched files), and before the final task `pnpm exec tsc --noEmit` and `pnpm exec eslint scripts src tests` must be clean. Baseline is **73/73 tests pass**.
- **RAM-constrained machine:** do not run heavy installs; there are none in this plan.

---

## File Structure

**New (SP1 module — one addition):**
- `src/lib/synergy/bound.ts` — `synergyUpperBound(present, addable, lookup)`: admissible upper bound on `scoreSynergy` over any completion. The heuristic that makes beam pruning safe.
- `src/lib/synergy/index.ts` — MODIFY: re-export `synergyUpperBound`.

**New (`src/lib/solver/`):**
- `src/lib/solver/types.ts` — `SolverContext`, `SolveOptions`, `SolveResult`, `RankedBuild`, `StatFit`, `BoundFn`.
- `src/lib/solver/stat-fit.ts` — `neutralStatFit: StatFit = () => 0`.
- `src/lib/solver/candidates.ts` — pool derivation (`deriveFragmentPool`, `deriveArtifactPerkPool`) + per-state candidate generation (`generateCandidates`).
- `src/lib/solver/beam.ts` — `SolverEnv`/`SolverState`, `buildSolverEnv` (feasibility precheck), `makeState`, `expand`, `beamSearch`.
- `src/lib/solver/solve.ts` — `solve()` orchestration + final ranking.
- `src/lib/solver/index.ts` — public surface: `solve`, `neutralStatFit`, and the public types.

**Tests:**
- `tests/synergy/bound.test.ts`
- `tests/solver/candidates.test.ts`
- `tests/solver/beam.test.ts`
- `tests/solver/solve.test.ts`
- `tests/solver/integration.test.ts`

---

## Task 1: `synergyUpperBound` — the admissible optimistic bound

**Files:**
- Create: `src/lib/synergy/bound.ts`
- Modify: `src/lib/synergy/index.ts`
- Test: `tests/synergy/bound.test.ts`

**Interfaces:**
- Consumes: `collectBuildElements` (`./elements`), `CHAIN_BASE`/`ELEMENT_ALIGNED_MULT`/`TRIGGER_SHARE`/`TRIGGER_GROUP_CAP`/`CURATED_OVERLAY` (`./weights`), `BuildElement` (`./types`), `scoreSynergy` (`./score`, test only), `Build`/`Keyword` (`@/lib/types`), `Lookup` (`@/lib/validation/types`).
- Produces: `synergyUpperBound(present: Build, addable: BuildElement[], lookup: Lookup): number` — an admissible (never-underestimating) upper bound on `scoreSynergy(present ∪ S).score` for every `S ⊆ addable`. Re-exported from `@/lib/synergy`.

**Why admissible without monotonicity:** `scoreSynergy` is NOT monotonic under adding elements (a lower-hash unaligned producer can steal a consumer from an aligned one, *lowering* the total), so "score the maximal build" is unsound. Instead we bound each term directly: for keyword `K`, any completion matches at most `min(#producers, #consumers)` reachable pairs, each at rank weight `CHAIN_BASE·r` and multiplier at most `ELEMENT_ALIGNED_MULT` — so `Σ_{r=1..pairs} 1.5·r = 1.5·T(pairs)` dominates every completion's `K`-chain weight. Triggers and overlay are bounded the same way. No pairing/alignment reshuffle can exceed these caps.

- [ ] **Step 1: Write the failing test**

Create `tests/synergy/bound.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { EMPTY_TAGS, type Build } from "@/lib/types";
import type { Lookup } from "@/lib/validation/types";
import type { BuildElement } from "@/lib/synergy/types";
import { scoreSynergy } from "@/lib/synergy/score";
import { synergyUpperBound } from "@/lib/synergy/bound";

const tags = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });

// Fragments 200/201/202 + artifact perks 400/401 form a small reachable universe.
const FRAGS: Record<number, { name: string; tags: typeof EMPTY_TAGS }> = {
  200: { name: "Prod", tags: tags({ produces: ["ignite", "surge"], element: "solar" }) },
  201: { name: "Flare", tags: tags({ produces: ["flare"], element: "solar" }) },
  202: { name: "Inert", tags: EMPTY_TAGS },
};
const PERKS: Record<number, { name: string; tags: typeof EMPTY_TAGS }> = {
  400: { name: "Ign", tags: tags({ consumes: ["ignite"] }) },
  401: { name: "Sur", tags: tags({ consumes: ["surge"] }) },
};

const lookup = {
  aspect: (h: number) =>
    h === 100 ? { hash: 100, name: "Asp", tags: tags({ consumes: ["flare"], element: "solar" }) } : undefined,
  fragment: (h: number) => (FRAGS[h] ? { hash: h, element: "solar", ...FRAGS[h] } : undefined),
  artifactPerk: (h: number) => (PERKS[h] ? { hash: h, ...PERKS[h] } : undefined),
} as unknown as Lookup;

const el = (hash: number, source: string, t: typeof EMPTY_TAGS): BuildElement => ({ hash, source, tags: t });

const present: Build = {
  subclass: { element: "solar", aspectHashes: [100], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
};

// Every element that could still be added to `present`.
const addable: BuildElement[] = [
  el(200, "fragment:Prod", FRAGS[200].tags),
  el(201, "fragment:Flare", FRAGS[201].tags),
  el(202, "fragment:Inert", EMPTY_TAGS),
  el(400, "artifact-perk:Ign", PERKS[400].tags),
  el(401, "artifact-perk:Sur", PERKS[401].tags),
];

describe("synergyUpperBound", () => {
  it("dominates scoreSynergy over every reachable completion (admissible)", () => {
    const bound = synergyUpperBound(present, addable, lookup);
    // Enumerate all subsets of the addable fragments/perks and score each build.
    const fragHashes = [200, 201, 202];
    const perkHashes = [400, 401];
    for (let f = 0; f < 1 << fragHashes.length; f++) {
      for (let p = 0; p < 1 << perkHashes.length; p++) {
        const frags = fragHashes.filter((_, i) => f & (1 << i));
        const perks = perkHashes.filter((_, i) => p & (1 << i));
        const build: Build = {
          ...present,
          subclass: { ...present.subclass, fragmentHashes: frags },
          artifact: { selectedPerkHashes: perks },
        };
        expect(scoreSynergy(build, lookup).score).toBeLessThanOrEqual(bound + 1e-9);
      }
    }
  });

  it("credits a producer's future chain only when a consumer is reachable", () => {
    // Producer present, its consumer reachable → bound > 0.
    const withConsumer = synergyUpperBound(present, [el(200, "f", FRAGS[200].tags), el(400, "p", PERKS[400].tags)], lookup);
    expect(withConsumer).toBeGreaterThan(0);
    // Producer reachable, NO consumer anywhere → bound stays 0.
    const noConsumer = synergyUpperBound(present, [el(200, "f", tags({ produces: ["ignite"] }))], lookup);
    expect(noConsumer).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- run tests/synergy/bound.test.ts`
Expected: FAIL — `synergyUpperBound` is not exported from `@/lib/synergy/bound` (module not found).

- [ ] **Step 3: Write the implementation**

Create `src/lib/synergy/bound.ts`:

```ts
import type { Build, Keyword } from "@/lib/types";

import type { Lookup } from "@/lib/validation/types";

import { collectBuildElements } from "./elements";
import type { BuildElement } from "./types";
import {
  CHAIN_BASE,
  CURATED_OVERLAY,
  ELEMENT_ALIGNED_MULT,
  TRIGGER_GROUP_CAP,
  TRIGGER_SHARE,
} from "./weights";

/** Sum of chain ranks 1..n = n(n+1)/2. */
function triangular(n: number): number {
  return (n * (n + 1)) / 2;
}

/**
 * An ADMISSIBLE upper bound on `scoreSynergy(present ∪ S).score` for every
 * `S ⊆ addable`. Used by the solver's beam to prune without ever discarding a
 * partial build whose best completion could still be optimal — in particular a
 * producer whose only consumer is still reachable in an open dimension.
 *
 * It bounds each scoring term over the reachable universe (present ∪ addable),
 * NOT by scoring a concrete build: `scoreSynergy` is non-monotonic under adding
 * elements (a lower-hash unaligned producer can steal a consumer from an aligned
 * one), so no single build's score is a safe bound. Per keyword there are at
 * most `min(#producers, #consumers)` chain links, each ≤ `ELEMENT_ALIGNED_MULT ·
 * CHAIN_BASE · rank`; triggers cap at `TRIGGER_GROUP_CAP` pairs per group; overlay
 * credits any entry whose both endpoints are reachable. Every completion's true
 * score is ≤ this sum.
 */
export function synergyUpperBound(
  present: Build,
  addable: BuildElement[],
  lookup: Lookup,
): number {
  // Reachable universe = present elements ∪ addable, deduped by hash.
  const byHash = new Map<number, BuildElement>();
  for (const e of collectBuildElements(present, lookup)) byHash.set(e.hash, e);
  for (const e of addable) if (!byHash.has(e.hash)) byHash.set(e.hash, e);
  const elements = [...byHash.values()];

  // Chain term: per keyword, min(producers, consumers) links, each optimistically
  // element-aligned (×ELEMENT_ALIGNED_MULT) at rank weights 1,2,3,… (CHAIN_BASE·r).
  const produce = new Map<Keyword, number>();
  const consume = new Map<Keyword, number>();
  for (const e of elements) {
    for (const k of e.tags.produces) produce.set(k, (produce.get(k) ?? 0) + 1);
    for (const k of e.tags.consumes) consume.set(k, (consume.get(k) ?? 0) + 1);
  }
  let chain = 0;
  for (const [k, p] of produce) {
    const pairs = Math.min(p, consume.get(k) ?? 0);
    if (pairs > 0) chain += ELEMENT_ALIGNED_MULT * CHAIN_BASE * triangular(pairs);
  }

  // Trigger term: per trigger group of size n, up to TRIGGER_GROUP_CAP pairs.
  const triggerCount = new Map<Keyword, number>();
  for (const e of elements) {
    for (const t of e.tags.triggers) triggerCount.set(t, (triggerCount.get(t) ?? 0) + 1);
  }
  let trigger = 0;
  for (const n of triggerCount.values()) {
    trigger += TRIGGER_SHARE * Math.min(TRIGGER_GROUP_CAP, (n * (n - 1)) / 2);
  }

  // Overlay term: any curated entry whose both endpoints are reachable (empty in v1).
  let overlay = 0;
  for (const o of CURATED_OVERLAY) {
    if (byHash.has(o.fromHash) && byHash.has(o.toHash)) overlay += o.weight;
  }

  return chain + trigger + overlay;
}
```

Modify `src/lib/synergy/index.ts` — add the re-export alongside the existing ones (after the `scoreSynergy` line):

```ts
export { getSynergies, scoreSynergy } from "./score";
export { synergyUpperBound } from "./bound";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- run tests/synergy/bound.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/synergy/bound.ts src/lib/synergy/index.ts tests/synergy/bound.test.ts
git commit -m "feat(synergy): add admissible synergyUpperBound for solver beam pruning"
```

---

## Task 2: Solver types + StatFit seam

**Files:**
- Create: `src/lib/solver/types.ts`
- Create: `src/lib/solver/stat-fit.ts`
- Test: `tests/solver/stat-fit.test.ts`

**Interfaces:**
- Consumes: `Build`/`Indexes` (`@/lib/types`), `Lookup` (`@/lib/validation`), `SynergyScore`/`BuildElement` (`@/lib/synergy`).
- Produces:
  - `interface SolverContext { lookup: Lookup; indexes: Indexes }`
  - `interface SolveOptions { beamWidth?: number; topN?: number; statFit?: StatFit; bound?: BoundFn }`
  - `interface StatFit { (build: Build, ctx: SolverContext): number }`
  - `type BoundFn = (present: Build, addable: BuildElement[], lookup: Lookup) => number`
  - `interface RankedBuild { build: Build; score: number; synergy: SynergyScore; statFit: number }`
  - `interface SolveResult { builds: RankedBuild[]; feasible: boolean }`
  - `const neutralStatFit: StatFit` (returns 0)

- [ ] **Step 1: Write the failing test**

Create `tests/solver/stat-fit.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { Build } from "@/lib/types";
import { neutralStatFit } from "@/lib/solver/stat-fit";
import type { SolverContext } from "@/lib/solver/types";

const anyBuild = {} as Build;
const anyCtx = {} as SolverContext;

describe("neutralStatFit", () => {
  it("is the v1 stub returning 0 for any build", () => {
    expect(neutralStatFit(anyBuild, anyCtx)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- run tests/solver/stat-fit.test.ts`
Expected: FAIL — cannot resolve `@/lib/solver/stat-fit` / `@/lib/solver/types`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/solver/types.ts`:

```ts
import type { Build, Indexes } from "@/lib/types";

import type { Lookup } from "@/lib/validation";

import type { BuildElement, SynergyScore } from "@/lib/synergy";

/** The injected read surfaces the solver operates through (no filesystem). */
export interface SolverContext {
  /** Entity resolution + artifact-perk lookup (the SP1/SP2 seam). */
  lookup: Lookup;
  /** Precomputed inverted indexes from the dataset (keyword, elementToItems, …). */
  indexes: Indexes;
}

/** A pluggable stat-fit term. SP4 replaces the stub without touching the solver. */
export interface StatFit {
  (build: Build, ctx: SolverContext): number;
}

/**
 * An admissible upper bound on the synergy any completion of `present` (adding a
 * subset of `addable`) could reach. Injectable so tests can prove the bound is
 * load-bearing (a zero bound must let the beam prune delayed-reward producers).
 */
export type BoundFn = (present: Build, addable: BuildElement[], lookup: Lookup) => number;

export interface SolveOptions {
  /** Beam width W — states kept per expansion round. Default 16. */
  beamWidth?: number;
  /** Number of ranked builds to return. Default 5. */
  topN?: number;
  /** Ranking stat-fit term. Default `neutralStatFit`. */
  statFit?: StatFit;
  /** Pruning bound. Default `synergyUpperBound`. Injected only in tests. */
  bound?: BoundFn;
}

/** One completed, ranked build with its "why". */
export interface RankedBuild {
  build: Build;
  /** Total = synergy.score + statFit. */
  score: number;
  synergy: SynergyScore;
  statFit: number;
}

export interface SolveResult {
  /** Top-N completed builds, best first. */
  builds: RankedBuild[];
  /** False if the pinned inputs admit no completion at all. */
  feasible: boolean;
}
```

Create `src/lib/solver/stat-fit.ts`:

```ts
import type { StatFit } from "./types";

/** v1 stat-fit stub — ranking is synergy-only until SP4 supplies the optimizer. */
export const neutralStatFit: StatFit = () => 0;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- run tests/solver/stat-fit.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/solver/types.ts src/lib/solver/stat-fit.ts tests/solver/stat-fit.test.ts
git commit -m "feat(solver): add solver context/result types + neutralStatFit seam"
```

---

## Task 3: Candidate generation (pools + per-state moves)

**Files:**
- Create: `src/lib/solver/candidates.ts`
- Test: `tests/solver/candidates.test.ts` (new file)

**Interfaces:**
- Consumes: `SolverContext` (`./types`); `Fragment`/`ArtifactPerk`/`Hash`/`SubclassElement`/`Artifact` (`@/lib/types`); `CapacityModel`/`buildCapacityModel`/`canAddArtifactPerk`/`Capacity` (`@/lib/validation`); `BuildElement` (`@/lib/synergy`).
- Produces:
  - `deriveFragmentPool(ctx: SolverContext, element: SubclassElement): Fragment[]` — the pinned element's fragments, resolved from `indexes.elementToItems`, sorted by hash.
  - `deriveArtifactPerkPool(ctx: SolverContext, artifact: Artifact): ArtifactPerk[]` — the artifact's distinct perks, sorted by hash.
  - `interface Candidate { kind: "fragment" | "artifactPerk"; hash: Hash; nativeTier?: number; element: BuildElement }`
  - `generateCandidates(env, fragHashes, perkHashes, cap): Candidate[]` where `env: Pick<SolverEnv, "fragmentPool" | "perkPool" | "fragmentCap" | "capModel">` (structural — Task 4 defines the full `SolverEnv`). Fragments offered only while `fragHashes.length < fragmentCap`; perks offered only when placeable and `canAddArtifactPerk` allows.

- [ ] **Step 1: Write the failing test**

Create `tests/solver/candidates.test.ts` (a fresh file — all imports at the top):

```ts
import { describe, expect, it } from "vitest";

import { EMPTY_TAGS } from "@/lib/types";
import type { Artifact, Fragment, SubclassElement } from "@/lib/types";
import { buildCapacityModel, evaluateArtifactCapacity } from "@/lib/validation";
import {
  deriveArtifactPerkPool,
  deriveFragmentPool,
  generateCandidates,
} from "@/lib/solver/candidates";
import type { SolverContext } from "@/lib/solver/types";

const frag = (hash: number, name: string): Fragment =>
  ({ kind: "fragment", hash, name, element: "solar", statModifiers: [], tags: EMPTY_TAGS } as Fragment);

// Fragment pool 202,200,201 (deliberately unsorted) + a non-fragment hash 999.
const fragments: Record<number, Fragment> = { 200: frag(200, "A"), 201: frag(201, "B"), 202: frag(202, "C") };

const artifact: Artifact = {
  kind: "artifact",
  hash: 300,
  name: "Art",
  tiers: [{ tierIndex: 0, slots: 2, perks: [
    { hash: 402, name: "P2", tags: EMPTY_TAGS },
    { hash: 400, name: "P0", tags: EMPTY_TAGS },
    { hash: 401, name: "P1", tags: EMPTY_TAGS },
  ] }],
};

const ctx = {
  lookup: {
    fragment: (h: number) => fragments[h],
    artifact: (h: number) => (h === 300 ? artifact : undefined),
    artifactPerk: (h: number) => artifact.tiers[0].perks.find((p) => p.hash === h),
  },
  indexes: { elementToItems: { solar: [999, 202, 200, 201] } },
} as unknown as SolverContext;

const capModel = buildCapacityModel(artifact);
const env = { fragmentPool: deriveFragmentPool(ctx, "solar" as SubclassElement), perkPool: deriveArtifactPerkPool(ctx, artifact), fragmentCap: 2, capModel };

describe("candidate pools", () => {
  it("derives the element's fragment pool sorted by hash, dropping non-fragments", () => {
    expect(env.fragmentPool.map((f) => f.hash)).toEqual([200, 201, 202]);
  });

  it("derives the artifact perk pool sorted by hash", () => {
    expect(env.perkPool.map((p) => p.hash)).toEqual([400, 401, 402]);
  });
});

describe("generateCandidates", () => {
  it("offers fragments only while under the slot cap, never duplicating chosen", () => {
    const cap = evaluateArtifactCapacity(capModel, []);
    const under = generateCandidates(env, [200], [], cap);
    expect(under.filter((c) => c.kind === "fragment").map((c) => c.hash)).toEqual([201, 202]);
    // At the cap (2 fragments), no fragment candidates remain.
    const atCap = generateCandidates(env, [200, 201], [], cap);
    expect(atCap.some((c) => c.kind === "fragment")).toBe(false);
  });

  it("gates perks by the capacity oracle and never duplicates chosen", () => {
    // 2 sockets total; choosing 2 perks leaves the oracle with no headroom.
    const capFull = evaluateArtifactCapacity(capModel, [400, 401]);
    const cands = generateCandidates(env, [], [400, 401], capFull);
    expect(cands.some((c) => c.kind === "artifactPerk")).toBe(false);
    // One perk chosen → the other two are still addable, chosen one excluded.
    const capOne = evaluateArtifactCapacity(capModel, [400]);
    const perkCands = generateCandidates(env, [], [400], capOne).filter((c) => c.kind === "artifactPerk");
    expect(perkCands.map((c) => c.hash)).toEqual([401, 402]);
  });

  it("carries the BuildElement (hash, source, tags) for the bound", () => {
    const cap = evaluateArtifactCapacity(capModel, []);
    const first = generateCandidates(env, [], [], cap)[0];
    expect(first.element.hash).toBe(first.hash);
    expect(first.element.source.length).toBeGreaterThan(0);
    expect(first.element.tags).toBe(fragments[first.hash].tags);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- run tests/solver/candidates.test.ts`
Expected: FAIL — cannot resolve `@/lib/solver/candidates`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/solver/candidates.ts`:

```ts
import type { Artifact, ArtifactPerk, Fragment, Hash, SubclassElement } from "@/lib/types";

import type { Capacity, CapacityModel } from "@/lib/validation";
import { canAddArtifactPerk } from "@/lib/validation";

import type { BuildElement } from "@/lib/synergy";

import type { SolverContext } from "./types";

const byHash = (a: { hash: Hash }, b: { hash: Hash }) => a.hash - b.hash;

/** The pinned element's fragment pool: element items that resolve to fragments. */
export function deriveFragmentPool(ctx: SolverContext, element: SubclassElement): Fragment[] {
  const hashes = ctx.indexes.elementToItems[element] ?? [];
  const seen = new Set<Hash>();
  const pool: Fragment[] = [];
  for (const h of hashes) {
    if (seen.has(h)) continue;
    const f = ctx.lookup.fragment(h);
    if (f && f.element === element) {
      seen.add(h);
      pool.push(f);
    }
  }
  return pool.sort(byHash);
}

/** The pinned artifact's distinct perks (pools are cumulative → dedup by hash). */
export function deriveArtifactPerkPool(_ctx: SolverContext, artifact: Artifact): ArtifactPerk[] {
  const seen = new Set<Hash>();
  const pool: ArtifactPerk[] = [];
  for (const tier of artifact.tiers) {
    for (const p of tier.perks) {
      if (seen.has(p.hash)) continue;
      seen.add(p.hash);
      pool.push(p);
    }
  }
  return pool.sort(byHash);
}

/** One legal move: add a fragment or an artifact perk to an open dimension. */
export interface Candidate {
  kind: "fragment" | "artifactPerk";
  hash: Hash;
  /** Native (lowest) tier — present only for artifact perks (for canAdd). */
  nativeTier?: number;
  /** Resolved tagged element, for the optimistic bound. */
  element: BuildElement;
}

/** The pieces of the solver env candidate generation needs (structural subset). */
interface CandidateEnv {
  fragmentPool: Fragment[];
  perkPool: ArtifactPerk[];
  fragmentCap: number;
  capModel: CapacityModel;
}

/**
 * Every legal add-one-element move from the given partial selection. Fragments
 * are offered only while under the aspect-granted slot cap; artifact perks only
 * when placeable (known native tier) and the SP2 oracle admits the addition.
 * Already-chosen hashes are never re-offered.
 */
export function generateCandidates(
  env: CandidateEnv,
  fragHashes: Hash[],
  perkHashes: Hash[],
  cap: Capacity,
): Candidate[] {
  const chosenFrag = new Set(fragHashes);
  const chosenPerk = new Set(perkHashes);
  const out: Candidate[] = [];

  if (fragHashes.length < env.fragmentCap) {
    for (const f of env.fragmentPool) {
      if (chosenFrag.has(f.hash)) continue;
      out.push({ kind: "fragment", hash: f.hash, element: { hash: f.hash, source: `fragment:${f.name}`, tags: f.tags } });
    }
  }

  for (const p of env.perkPool) {
    if (chosenPerk.has(p.hash)) continue;
    const nativeTier = env.capModel.nativeTier.get(p.hash);
    if (nativeTier === undefined) continue; // unplaceable (unknown) perk
    if (!canAddArtifactPerk(env.capModel, cap, nativeTier)) continue;
    out.push({ kind: "artifactPerk", hash: p.hash, nativeTier, element: { hash: p.hash, source: `artifact-perk:${p.name}`, tags: p.tags } });
  }

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- run tests/solver/candidates.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/lib/solver/candidates.ts tests/solver/candidates.test.ts
git commit -m "feat(solver): fragment/perk pool derivation + oracle-gated candidate generation"
```

---

## Task 4: Beam search core (env, state, expansion, search)

**Files:**
- Create: `src/lib/solver/beam.ts`
- Test: `tests/solver/beam.test.ts`

**Interfaces:**
- Consumes: `Build`/`Hash`/`SubclassElement`/`Fragment`/`ArtifactPerk` (`@/lib/types`); `buildCapacityModel`/`evaluateArtifactCapacity`/`CapacityModel`/`Capacity` (`@/lib/validation`); `scoreSynergy`/`SynergyScore` (`@/lib/synergy`); `SolverContext`/`SolveOptions`/`StatFit`/`BoundFn` (`./types`); `Candidate`/`generateCandidates`/`deriveFragmentPool`/`deriveArtifactPerkPool` (`./candidates`).
- Produces:
  - `interface SolverEnv { ctx; lookup; base; element; fragmentCap; fragmentPool; capModel; perkPool; beamWidth; topN; statFit }`
  - `interface SolverState { build; fragHashes; perkHashes; cap; realized: SynergyScore; candidates: Candidate[]; priority: number; key: string }`
  - `buildSolverEnv(base: Build, ctx: SolverContext, options?: SolveOptions): SolverEnv | null` — returns `null` when the pinned inputs admit no completion (element unpinned, artifact unresolved, pinned perks over capacity, or pinned fragments over cap).
  - `makeState(env, fragHashes, perkHashes, bound): SolverState`
  - `expand(state, env, bound): SolverState[]`
  - `beamSearch(env, bound): SolverState[]` — the completed (terminal) states.
  - `stateKey(fragHashes, perkHashes): string`

- [ ] **Step 1: Write the failing test**

Create `tests/solver/beam.test.ts` — the **delayed-reward** acceptance test plus determinism:

```ts
import { describe, expect, it } from "vitest";

import { EMPTY_TAGS, type Artifact, type Aspect, type Build, type Fragment } from "@/lib/types";
import type { Lookup } from "@/lib/validation";
import { synergyUpperBound } from "@/lib/synergy";
import { neutralStatFit } from "@/lib/solver/stat-fit";
import { beamSearch, buildSolverEnv } from "@/lib/solver/beam";
import type { SolverContext } from "@/lib/solver/types";

const tag = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });

// ── Synthetic world ─────────────────────────────────────────────────────────
// Aspect 100 (solar) grants ONE fragment slot and consumes "flare".
// Fragment 200 (F_PROD) produces ignite+surge — its consumers are artifact perks.
// Fragment 201 (F_DECOY) produces "flare" → immediately chains with aspect 100 (1.5).
// Fragment 202 (F_INERT) has no tags. Only ONE fragment slot, so they compete.
// Artifact 300 has 3 sockets: perk 400 consumes ignite, 401 consumes surge, 402 inert.
const aspect100: Aspect = { kind: "aspect", hash: 100, name: "Asp", element: "solar", classType: "any", fragmentSlots: 1, tags: tag({ consumes: ["flare"], element: "solar" }) };
const frag = (hash: number, name: string, tags: typeof EMPTY_TAGS): Fragment => ({ kind: "fragment", hash, name, element: "solar", statModifiers: [], tags });
const F: Record<number, Fragment> = {
  200: frag(200, "Prod", tag({ produces: ["ignite", "surge"], element: "solar" })),
  201: frag(201, "Decoy", tag({ produces: ["flare"], element: "solar" })),
  202: frag(202, "Inert", EMPTY_TAGS),
};
const artifact300: Artifact = { kind: "artifact", hash: 300, name: "Art", tiers: [{ tierIndex: 0, slots: 3, perks: [
  { hash: 400, name: "Ign", tags: tag({ consumes: ["ignite"] }) },
  { hash: 401, name: "Sur", tags: tag({ consumes: ["surge"] }) },
  { hash: 402, name: "Inert", tags: EMPTY_TAGS },
] }] };

const lookup = {
  aspect: (h: number) => (h === 100 ? aspect100 : undefined),
  fragment: (h: number) => F[h],
  artifact: (h: number) => (h === 300 ? artifact300 : undefined),
  artifactPerk: (h: number) => artifact300.tiers[0].perks.find((p) => p.hash === h),
} as unknown as Lookup;

const ctx: SolverContext = { lookup, indexes: { elementToItems: { solar: [200, 201, 202] } } as unknown as SolverContext["indexes"] };

const pinned = (): Build => ({
  subclass: { element: "solar", aspectHashes: [100], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { artifactHash: 300, selectedPerkHashes: [] },
  constraints: [],
});

const topByRealized = (states: ReturnType<typeof beamSearch>) =>
  [...states].sort((a, b) => b.realized.score - a.realized.score || (a.key < b.key ? -1 : 1))[0];

describe("beamSearch — delayed reward", () => {
  it("keeps a producer whose only consumer is an artifact perk (bound ON, W=1)", () => {
    const env = buildSolverEnv(pinned(), ctx, { beamWidth: 1, statFit: neutralStatFit })!;
    const best = topByRealized(beamSearch(env, synergyUpperBound));
    expect(best.fragHashes).toContain(200); // F_PROD survived the width-1 beam
    expect(best.realized.score).toBeCloseTo(2, 6); // ignite (1) + surge (1)
  });

  it("FAILS to keep the producer with a zero bound (proves the bound is load-bearing)", () => {
    const env = buildSolverEnv(pinned(), ctx, { beamWidth: 1, statFit: neutralStatFit })!;
    const best = topByRealized(beamSearch(env, () => 0));
    expect(best.fragHashes).not.toContain(200); // realized-only beam pruned F_PROD
    expect(best.fragHashes).toContain(201); // it chose the immediate decoy chain
    expect(best.realized.score).toBeCloseTo(1.5, 6); // flare chain only
  });

  it("is deterministic under permuted pool/input order", () => {
    const envA = buildSolverEnv(pinned(), ctx, { beamWidth: 1 })!;
    const permutedCtx: SolverContext = { lookup, indexes: { elementToItems: { solar: [202, 201, 200] } } as unknown as SolverContext["indexes"] };
    const permutedBuild = pinned();
    permutedBuild.artifact.selectedPerkHashes = [];
    const envB = buildSolverEnv(permutedBuild, permutedCtx, { beamWidth: 1 })!;
    const a = topByRealized(beamSearch(envA, synergyUpperBound));
    const b = topByRealized(beamSearch(envB, synergyUpperBound));
    expect(b.key).toBe(a.key);
    expect(b.realized.score).toBeCloseTo(a.realized.score, 6);
  });
});

describe("buildSolverEnv — feasibility", () => {
  it("returns null when the artifact is unresolved", () => {
    const bad = pinned();
    bad.artifact.artifactHash = 999;
    expect(buildSolverEnv(bad, ctx)).toBeNull();
  });

  it("returns null when pinned fragments exceed the slot cap", () => {
    const over = pinned();
    over.subclass.fragmentHashes = [200, 201]; // cap is 1
    expect(buildSolverEnv(over, ctx)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- run tests/solver/beam.test.ts`
Expected: FAIL — cannot resolve `@/lib/solver/beam`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/solver/beam.ts`:

```ts
import type { ArtifactPerk, Build, Fragment, Hash, SubclassElement } from "@/lib/types";

import type { Capacity, CapacityModel } from "@/lib/validation";
import { buildCapacityModel, evaluateArtifactCapacity } from "@/lib/validation";

import type { SynergyScore } from "@/lib/synergy";
import { scoreSynergy } from "@/lib/synergy";

import {
  deriveArtifactPerkPool,
  deriveFragmentPool,
  generateCandidates,
  type Candidate,
} from "./candidates";
import { neutralStatFit } from "./stat-fit";
import type { BoundFn, SolveOptions, SolverContext, StatFit } from "./types";

export const DEFAULT_BEAM_WIDTH = 16;
export const DEFAULT_TOP_N = 5;

/** Everything the beam needs, resolved once from the pinned inputs. */
export interface SolverEnv {
  ctx: SolverContext;
  lookup: SolverContext["lookup"];
  base: Build;
  element: SubclassElement;
  fragmentCap: number;
  fragmentPool: Fragment[];
  capModel: CapacityModel;
  perkPool: ArtifactPerk[];
  beamWidth: number;
  topN: number;
  statFit: StatFit;
}

/** A partial build in the beam. `candidates` are its legal add-one-element moves. */
export interface SolverState {
  build: Build;
  fragHashes: Hash[];
  perkHashes: Hash[];
  cap: Capacity;
  realized: SynergyScore;
  candidates: Candidate[];
  priority: number;
  key: string;
}

/** Order-independent identity for a partial build (dedup + stable tie-break). */
export function stateKey(fragHashes: Hash[], perkHashes: Hash[]): string {
  const s = (xs: Hash[]) => [...xs].sort((a, b) => a - b).join(",");
  return `frag:${s(fragHashes)}|perk:${s(perkHashes)}`;
}

/**
 * Resolve the pinned inputs into a `SolverEnv`, or `null` if they admit no
 * completion at all (SP3a's feasibility = element pinned, artifact resolvable,
 * pinned perks within capacity, pinned fragments within the slot cap).
 */
export function buildSolverEnv(
  base: Build,
  ctx: SolverContext,
  options: SolveOptions = {},
): SolverEnv | null {
  const element = base.subclass.element;
  if (element === undefined) return null;

  const artifactHash = base.artifact.artifactHash;
  const artifact = artifactHash === undefined ? undefined : ctx.lookup.artifact(artifactHash);
  if (!artifact) return null;

  const capModel = buildCapacityModel(artifact);
  if (!evaluateArtifactCapacity(capModel, base.artifact.selectedPerkHashes).feasible) return null;

  const fragmentCap = base.subclass.aspectHashes.reduce(
    (sum, h) => sum + (ctx.lookup.aspect(h)?.fragmentSlots ?? 0),
    0,
  );
  if (base.subclass.fragmentHashes.length > fragmentCap) return null;

  return {
    ctx,
    lookup: ctx.lookup,
    base,
    element,
    fragmentCap,
    fragmentPool: deriveFragmentPool(ctx, element),
    capModel,
    perkPool: deriveArtifactPerkPool(ctx, artifact),
    beamWidth: options.beamWidth ?? DEFAULT_BEAM_WIDTH,
    topN: options.topN ?? DEFAULT_TOP_N,
    statFit: options.statFit ?? neutralStatFit,
  };
}

/** Build a fully-derived state from a fragment/perk selection. */
export function makeState(
  env: SolverEnv,
  fragHashes: Hash[],
  perkHashes: Hash[],
  bound: BoundFn,
): SolverState {
  const frag = [...fragHashes].sort((a, b) => a - b);
  const perk = [...perkHashes].sort((a, b) => a - b);
  const build: Build = {
    ...env.base,
    subclass: { ...env.base.subclass, fragmentHashes: frag },
    artifact: { ...env.base.artifact, selectedPerkHashes: perk },
  };
  const cap = evaluateArtifactCapacity(env.capModel, perk);
  const realized = scoreSynergy(build, env.lookup);
  const candidates = generateCandidates(env, frag, perk, cap);
  const priority = bound(build, candidates.map((c) => c.element), env.lookup);
  return { build, fragHashes: frag, perkHashes: perk, cap, realized, candidates, priority, key: stateKey(frag, perk) };
}

/** All successor states — one per legal move from `state`. */
export function expand(state: SolverState, env: SolverEnv, bound: BoundFn): SolverState[] {
  return state.candidates.map((c) =>
    c.kind === "fragment"
      ? makeState(env, [...state.fragHashes, c.hash], state.perkHashes, bound)
      : makeState(env, state.fragHashes, [...state.perkHashes, c.hash], bound),
  );
}

/**
 * Beam search over the two open dimensions. Each round expands the beam, routes
 * terminal (no-move) states to `completed`, dedups successors by build key, and
 * keeps the top-`beamWidth` by priority, breaking ties by realized synergy and
 * then by key. Because the priority is an admissible upper bound, a promising
 * producer is never pruned before its consumer can be added. The realized-score
 * tie-break matters when the bound is uninformative (e.g. a zero bound degenerates
 * the beam to a greedy realized-only search, the naive baseline the bound beats).
 */
export function beamSearch(env: SolverEnv, bound: BoundFn): SolverState[] {
  let beam: SolverState[] = [makeState(env, env.base.subclass.fragmentHashes, env.base.artifact.selectedPerkHashes, bound)];
  const completed: SolverState[] = [];
  const seen = new Set<string>();

  while (beam.length > 0) {
    const byKey = new Map<string, SolverState>();
    for (const state of beam) {
      const kids = expand(state, env, bound);
      if (kids.length === 0) {
        completed.push(state);
        continue;
      }
      for (const kid of kids) {
        if (seen.has(kid.key) || byKey.has(kid.key)) continue;
        byKey.set(kid.key, kid);
      }
    }
    for (const key of byKey.keys()) seen.add(key);
    beam = [...byKey.values()]
      .sort((a, b) => b.priority - a.priority || b.realized.score - a.realized.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .slice(0, env.beamWidth);
  }

  return completed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- run tests/solver/beam.test.ts`
Expected: PASS (5 tests) — critically, the bound-ON test keeps hash 200 and the zero-bound test does not.

- [ ] **Step 5: Commit**

```bash
git add src/lib/solver/beam.ts tests/solver/beam.test.ts
git commit -m "feat(solver): unified add-one-element beam search with optimistic-bound pruning"
```

---

## Task 5: `solve()` orchestration + ranking + public surface

**Files:**
- Create: `src/lib/solver/solve.ts`
- Create: `src/lib/solver/index.ts`
- Test: `tests/solver/solve.test.ts`

**Interfaces:**
- Consumes: `Build` (`@/lib/types`); `scoreSynergy`/`synergyUpperBound` (`@/lib/synergy`); `SolverContext`/`SolveOptions`/`SolveResult`/`RankedBuild`/`BoundFn` (`./types`); `buildSolverEnv`/`beamSearch`/`SolverState` (`./beam`).
- Produces: `solve(build: Build, ctx: SolverContext, options?: SolveOptions): SolveResult`. Ranks completed builds by `synergy.score + statFit` (ties by build key), returns top-`N`; `feasible: false` with empty `builds` when `buildSolverEnv` returns null. `src/lib/solver/index.ts` exports `solve`, `neutralStatFit`, and the public types.

- [ ] **Step 1: Write the failing test**

Create `tests/solver/solve.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { EMPTY_TAGS, type Artifact, type Aspect, type Build, type Fragment } from "@/lib/types";
import type { Lookup } from "@/lib/validation";
import { solve } from "@/lib/solver";
import type { SolverContext } from "@/lib/solver";

const tag = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });
const aspect100: Aspect = { kind: "aspect", hash: 100, name: "Asp", element: "solar", classType: "any", fragmentSlots: 1, tags: tag({ consumes: ["flare"], element: "solar" }) };
const frag = (hash: number, name: string, tags: typeof EMPTY_TAGS): Fragment => ({ kind: "fragment", hash, name, element: "solar", statModifiers: [], tags });
const F: Record<number, Fragment> = {
  200: frag(200, "Prod", tag({ produces: ["ignite", "surge"], element: "solar" })),
  201: frag(201, "Decoy", tag({ produces: ["flare"], element: "solar" })),
  202: frag(202, "Inert", EMPTY_TAGS),
};
const artifact300: Artifact = { kind: "artifact", hash: 300, name: "Art", tiers: [{ tierIndex: 0, slots: 3, perks: [
  { hash: 400, name: "Ign", tags: tag({ consumes: ["ignite"] }) },
  { hash: 401, name: "Sur", tags: tag({ consumes: ["surge"] }) },
  { hash: 402, name: "Inert", tags: EMPTY_TAGS },
] }] };
const lookup = {
  aspect: (h: number) => (h === 100 ? aspect100 : undefined),
  fragment: (h: number) => F[h],
  artifact: (h: number) => (h === 300 ? artifact300 : undefined),
  artifactPerk: (h: number) => artifact300.tiers[0].perks.find((p) => p.hash === h),
} as unknown as Lookup;
const ctx: SolverContext = { lookup, indexes: { elementToItems: { solar: [200, 201, 202] } } as unknown as SolverContext["indexes"] };
const pinned = (): Build => ({
  subclass: { element: "solar", aspectHashes: [100], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { artifactHash: 300, selectedPerkHashes: [] },
  constraints: [],
});

describe("solve", () => {
  it("returns feasible top-N builds ranked by synergy, best first", () => {
    const result = solve(pinned(), ctx, { topN: 3 });
    expect(result.feasible).toBe(true);
    expect(result.builds.length).toBeGreaterThan(0);
    expect(result.builds.length).toBeLessThanOrEqual(3);
    // Sorted descending by score.
    for (let i = 1; i < result.builds.length; i++) {
      expect(result.builds[i - 1].score).toBeGreaterThanOrEqual(result.builds[i].score);
    }
    // score === synergy.score + statFit (stat-fit is 0 in v1).
    const top = result.builds[0];
    expect(top.score).toBeCloseTo(top.synergy.score + top.statFit, 6);
    expect(top.statFit).toBe(0);
  });

  it("finds the delayed-reward build (F_PROD + its perk consumers) at the top", () => {
    const top = solve(pinned(), ctx, { beamWidth: 16 }).builds[0];
    expect(top.build.subclass.fragmentHashes).toContain(200);
    expect(top.synergy.score).toBeCloseTo(2, 6);
    expect(top.synergy.synergies.every((s) => s.why.length > 0)).toBe(true);
  });

  it("reports infeasible with no builds when the artifact is unresolved", () => {
    const bad = pinned();
    bad.artifact.artifactHash = 999;
    expect(solve(bad, ctx)).toEqual({ builds: [], feasible: false });
  });

  it("keeps pre-pinned fragments/perks in the completed builds", () => {
    const withPins = pinned();
    withPins.artifact.selectedPerkHashes = [402];
    const top = solve(withPins, ctx).builds[0];
    expect(top.build.artifact.selectedPerkHashes).toContain(402);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- run tests/solver/solve.test.ts`
Expected: FAIL — cannot resolve `@/lib/solver` (no `index.ts` / `solve.ts`).

- [ ] **Step 3: Write the implementation**

Create `src/lib/solver/solve.ts`:

```ts
import type { Build } from "@/lib/types";

import { synergyUpperBound } from "@/lib/synergy";

import { beamSearch, buildSolverEnv, type SolverState } from "./beam";
import type { BoundFn, RankedBuild, SolveOptions, SolveResult, SolverContext } from "./types";

/**
 * Complete a partially-pinned build over its two open dimensions (subclass
 * fragments + artifact perks) and return the top-N by synergy + stat-fit.
 *
 * Contract: `build.subclass.element` + `aspectHashes` and `artifact.artifactHash`
 * are pinned; the solver fills `fragmentHashes` + `selectedPerkHashes`. Any
 * fragments/perks already present are kept. `feasible` is false (with no builds)
 * iff the pinned inputs admit no completion.
 */
export function solve(build: Build, ctx: SolverContext, options: SolveOptions = {}): SolveResult {
  const env = buildSolverEnv(build, ctx, options);
  if (env === null) return { builds: [], feasible: false };

  const bound: BoundFn = options.bound ?? synergyUpperBound;
  const completed = beamSearch(env, bound);

  const ranked = completed
    .map((state: SolverState): RankedBuild & { key: string } => {
      const statFit = env.statFit(state.build, ctx);
      return { build: state.build, synergy: state.realized, statFit, score: state.realized.score + statFit, key: state.key };
    })
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, env.topN)
    .map(({ key: _key, ...rest }) => rest);

  return { builds: ranked, feasible: true };
}
```

Create `src/lib/solver/index.ts`:

```ts
/**
 * Solver seam. Completes a partially-pinned build via beam search over subclass
 * fragments + artifact perks, ranked by synergy (SP1) + a stubbed stat-fit seam
 * (SP4). Pure and dependency-injected: all data arrives via `SolverContext`.
 */

export { solve } from "./solve";
export { neutralStatFit } from "./stat-fit";
export type {
  BoundFn,
  RankedBuild,
  SolveOptions,
  SolveResult,
  SolverContext,
  StatFit,
} from "./types";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- run tests/solver/solve.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/solver/solve.ts src/lib/solver/index.ts tests/solver/solve.test.ts
git commit -m "feat(solver): solve() orchestration, synergy+statFit ranking, public surface"
```

---

## Task 6: Real-dataset integration + full green gate

**Files:**
- Create: `tests/solver/integration.test.ts`

**Interfaces:**
- Consumes: `loadDataset` (`@/lib/data`); `createLookup` (`@/lib/validation`); `scoreSynergy` (`@/lib/synergy`); `solve`/`SolverContext` (`@/lib/solver`); `Build`/`DerivedDataset` (`@/lib/types`).
- Produces: nothing (test-only). Guarded by `describe.runIf(hasDataset)` exactly like `tests/synergy/integration.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/solver/integration.test.ts`:

```ts
import { existsSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import type { Build, DerivedDataset } from "@/lib/types";
import { createLookup, type Lookup } from "@/lib/validation";
import { scoreSynergy } from "@/lib/synergy";
import { solve, type SolverContext } from "@/lib/solver";

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));

const emptyBuild = (): Build => ({
  subclass: { aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
});

describe.runIf(hasDataset)("solver (integration)", () => {
  let ds: DerivedDataset;
  let lookup: Lookup;
  let ctx: SolverContext;

  beforeAll(async () => {
    ds = await loadDataset();
    lookup = createLookup(ds);
    ctx = { lookup, indexes: ds.indexes };
  });

  /** Pin an element that has both an aspect (granting fragment slots) and an artifact. */
  const pinFor = (element: DerivedDataset["fragments"][number]["element"]): Build | undefined => {
    const aspect = ds.aspects.find((a) => a.element === element && a.fragmentSlots > 0);
    const artifact = ds.artifacts[0];
    if (!aspect || !artifact) return undefined;
    return {
      ...emptyBuild(),
      subclass: { element, aspectHashes: [aspect.hash], fragmentHashes: [] },
      artifact: { artifactHash: artifact.hash, selectedPerkHashes: [] },
    };
  };

  it("completes a feasible pinned build with explained synergies", () => {
    // Use the element of the first fragment that carries any tags.
    const seed = ds.fragments.find((f) => f.tags.produces.length + f.tags.consumes.length > 0) ?? ds.fragments[0];
    const build = pinFor(seed.element);
    expect(build, "expected an aspect + artifact for the seed element").toBeTruthy();

    const result = solve(build!, ctx, { topN: 5 });
    expect(result.feasible).toBe(true);
    expect(result.builds.length).toBeGreaterThan(0);

    const top = result.builds[0];
    // Solving fills fragment slots and never lowers synergy below the pinned-only baseline.
    const baseline = scoreSynergy(build!, lookup).score;
    expect(top.score).toBeGreaterThanOrEqual(baseline);
    // Any synergy reported carries a human-readable "why".
    expect(top.synergy.synergies.every((s) => s.why.length > 0)).toBe(true);
    // score === realized synergy + stat-fit stub.
    expect(top.score).toBeCloseTo(top.synergy.score + top.statFit, 6);
  });

  it("ranks a synergy-coupled completion above the empty pinned build", () => {
    const seed = ds.fragments.find((f) => f.tags.produces.length + f.tags.consumes.length > 0) ?? ds.fragments[0];
    const build = pinFor(seed.element)!;
    const solved = solve(build, ctx, { topN: 1 });
    expect(solved.builds[0].score).toBeGreaterThanOrEqual(scoreSynergy(build, lookup).score);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or skips), then run the whole suite**

Run: `pnpm test -- run tests/solver/integration.test.ts`
Expected: PASS if `data/` is present; **skipped** (0 tests, no failure) if not — the `runIf(hasDataset)` guard mirrors `tests/synergy/integration.test.ts`. Either outcome is acceptable for this step; do not add a failing assertion for the skip case.

- [ ] **Step 3: Run the full green gate**

Run: `pnpm test -- run`
Expected: All prior tests (73) plus the new solver + bound tests PASS, 0 fail.

Run: `pnpm exec tsc --noEmit`
Expected: no output (clean).

Run: `pnpm exec eslint scripts src tests`
Expected: no output (clean). Fix any import-order or unused-import findings by mirroring the grouping in existing `src/lib/synergy/*.ts` files.

- [ ] **Step 4: Commit**

```bash
git add tests/solver/integration.test.ts
git commit -m "test(solver): real-dataset integration — feasible completion, explained synergies"
```

---

## Self-Review

**1. Spec coverage:**

| Spec requirement | Task |
|---|---|
| New pure, DI'd `src/lib/solver/`; imports only through SP1/SP2 seams | Tasks 2–5 (Global Constraints enforce it) |
| `solve(build, ctx, options?) → SolveResult`; `ctx = {lookup, indexes}`; `options {beamWidth?=16, topN?=5}` | Task 5 (defaults in `beam.ts`: `DEFAULT_BEAM_WIDTH=16`, `DEFAULT_TOP_N=5`) |
| `RankedBuild {build, score, synergy, statFit}`; `SolveResult {builds, feasible}` | Task 2 |
| Input contract: pin element+aspects (fragment cap) + artifact (perk pool); fill two open dims; keep pre-present | Tasks 4 (`buildSolverEnv`, `makeState`) + 5 (`solve`) + solve.test "keeps pre-pinned" |
| Beam: state = partial build; move = add one fragment (slot cap) OR one perk (`canAddArtifactPerk`) | Tasks 3 (`generateCandidates`) + 4 (`expand`) |
| Prune by `realized + optimisticBound`, **admissible**; final ranking by realized `scoreSynergy.score + statFit` | Task 1 (`synergyUpperBound`, admissibility test) + Task 4 (priority = bound) + Task 5 (ranking by realized) |
| Optimistic bound credited only if an open pool supplies the complement | Task 1 (`credits… only when a consumer is reachable` test); enforced because `addable` = still-addable pool candidates |
| `StatFit` seam + `neutralStatFit → 0` | Task 2 |
| Determinism across permuted order | Task 4 (`is deterministic under permuted pool/input order`) |
| **Delayed-reward test that FAILS if the bound is removed** | Task 4 (bound-ON keeps hash 200; zero-bound does not) — the acceptance gate |
| Bound is a genuine upper bound on synthetic pools | Task 1 (subset-enumeration admissibility test) |
| Candidate-gen respects cap + oracle; keeps pre-present, no dup | Task 3 |
| Integration: completion feasible, non-empty `why`, coupled ≥ baseline | Task 6 |

*Note on `realized + optimisticBound`:* the plan implements the prune key as the single admissible upper bound `synergyUpperBound(present, addable)`, which equals "realized + optimistic completion bound" collapsed into one number. This was chosen (and confirmed with the user) over a literal `realized + separate-gain` split because the split form is **not** admissible under `scoreSynergy`'s non-monotonic element-alignment reshuffling; the single-bound form provably dominates every completion. This is the design's stated correctness property (admissibility), preserved.

**2. Placeholder scan:** No `TODO`/`TBD`/"add error handling"/"similar to Task N". Every code step shows complete code; every test step shows complete test code.

**3. Type consistency:** `synergyUpperBound(present, addable, lookup)` — signature identical in Task 1 (def), `BoundFn` (Task 2), and `makeState`/`beamSearch`/`solve` call sites (Tasks 4–5). `Candidate` shape identical across Tasks 3–4. `SolverEnv`/`SolverState` fields referenced in Task 4 tests match the definitions. `evaluateArtifactCapacity`/`canAddArtifactPerk`/`buildCapacityModel` names match the SP2 re-exports in `@/lib/validation`. `Indexes` is the `@/lib/types` dataset type throughout (never redefined). `elementToItems` / `nativeTier` / `slots` / `tiers` field names match `entities.ts` + `artifact-capacity.ts`.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-23-phase2-sp3a-solver-beam-search.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. (Matches the SP1/SP2 flow the handoff records.)

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
