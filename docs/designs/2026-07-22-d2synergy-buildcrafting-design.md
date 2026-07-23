# D2Synergy — Constraint-Based Buildcrafting Tool (Design)

**Date:** 2026-07-22
**Status:** Approved (design) — pending implementation plan
**Repo:** `D2Synergy`

---

## 1. Overview & Scope

D2Synergy is a **Next.js (TypeScript) full-stack web app** for **constraint-based Destiny 2 buildcrafting** over a **frozen, pre-ingested Manifest dataset**.

**Core loop:** the user specifies partial build constraints → the solver validates feasibility and completes/suggests the rest → the synergy engine explains *why* the pieces work together.

> User framing of the core value: *"i specify desired build features and/or constraints (use X exotic, have a weapon with X perks, use X subclass, etc). validate feasibility and suggest synergies."*

### What a "build" is
> User definition: *"'build' = armor/weapon/ability combos."* Expanded through brainstorming into:

- **Subclass** — element + super + aspects + fragments
- **Weapons** — up to 3 slots, optionally constrained by perks / archetype / element / frame
- **Armor** — 5 pieces (incl. one exotic), stat distribution, mod slots, **set bonuses** (2-piece / 4-piece thresholds grant global perks)
- **Mods** — armor mods, artifact/keyword mods
- **Artifact** — see §2. A perk matrix that provides *significant* build input

### Key design driver: the game is frozen
> User note: *"The game will not receive any more updates."*

This turns "keep the data fresh" into a **non-problem** and makes the curated synergy layer a **one-time investment** rather than a maintenance treadmill. It is the single most important simplifying constraint in the design.

### In scope for v1
- Deterministic feasibility + synergy engine over **all game content** (pure Manifest).
- Web UI (build canvas + constraint panel + ranked results with "why").

### Deferred (designed-for, not built in v1)
- **Ownership toggle** — "what I own" via OAuth + live inventory. *"all now, personalized later - with potential toggle."*
- **Graph-embedding synergy layer** (phase 3 ML). *"combo of 1 and 2, with potential for 3 in the future."*
- **LLM-assisted reasoning** (later).

### Non-goals
Activity recommendations, live world state (Xûr / vendors / rotations), match-history / stats tracking.
> *"activities themselves matter less - more about desired build."*

---

## 2. Data Model & the Manifest Slice

The engine operates on a **derived, buildcrafting-focused dataset**, not the raw Manifest.

### Architecture decision: Approach B — static pre-processed dataset, no runtime DB
A **one-time ingestion pipeline** downloads the Manifest once, slims it to buildcrafting-relevant tables/fields, pre-computes synergy keyword tags + indexes, and emits a **compact, versioned dataset committed to the repo**. The app consumes this directly (in-memory server-side, and/or shipped to the client for instant filtering).

- Chosen over **Approach A** (live Manifest + runtime DB refresh) — pointless for a frozen game.
- **Approach C** (ingest → read-only SQLite asset) is the documented **fallback** if plain-JS querying becomes painful. The data-access layer is designed so the derived dataset can graduate into SQLite **without touching the solver's interface.**

### Entities extracted
- **Subclasses** — element, super, aspect definitions (incl. **fragment slot counts per aspect**), fragment definitions (incl. stat penalties/bonuses).
- **Weapons** — archetype/frame, element, slot, and **perk pools** (from `DestinyPlugSetDefinition`) so *"can this weapon roll perk X, and perk Y in the same column?"* is answerable.
- **Armor** — exotics (with exotic perk), stat groups, mod socket layout, **set identity** (for set bonuses).
- **Armor sets** — 2pc / 4pc bonus perks per set.
- **Mods** — armor mods, energy cost, effects.
- **Artifacts** — all 7 matrices (see below).
- **Perks/effects** — `DestinySandboxPerkDefinition` text + **extracted buildcrafting keyword tags**.

### The artifact (first-class build element)
> User spec: *"a matrix of additional tiered perks. you have 21 total perks, 7 of tiers 1-3, and you can select perks with a ceiling of tier. The game has 7 artifacts (permanently...) and these provide *significant* input to builds."*

- **21 perks arranged in 3 tiers of 7.** Selection under a **tier ceiling** (must unlock enough lower-tier perks to access higher tiers) plus an active-count cap.
- **7 distinct artifacts exist permanently**, each with its own matrix.
- **Solver treatment:** *"pick artifact + selected perks within artifact. possible to pin artifact if desired but allow for synergy calculations."* → the artifact is a constraint dimension: pin it, or let the solver evaluate all 7 to find the best synergy fit, auto-selecting perks under the tier/count rules.
- Artifact perks feed **both feasibility** (e.g. anti-champion coverage) **and synergy** (keyword generation: Volatile/Jolt/Ignition/etc.).

> ✅ **Resolved (Phase 0, 2026-07-22 — research spike + rework):** there **are 7 artifacts**, but they're **not** in `DestinyArtifactDefinition` (that table returns only the current season's — Bungie's documented behavior). The 2026 "Monument of Triumph" update (9.7.0, 2026-06-09) exposes all 7 (current + last 6 seasons) as **`DestinyInventoryItemDefinition` items** with `itemTypeDisplayName: "Artifact"` in the Artifacts bucket (`1506418338`), each carrying **8 sockets**. Ingestion now sources them from there (`transform.ts` → `transformArtifacts` via `classifier.isArtifact`).
>
> **Confirmed structure (per artifact):** 3 perk **tiers** from 3 socket categories — socket groups **2 / 3 / 2** (+ 1 reset socket, dropped) — with perk pools of **7 / 14 / 21** (raw 8/15/22 minus the empty-mod plug). In-game **slot-capacity rules** (from the 9.7.0 UI): Tier 1 fills all 7 slots, Tier 2 the last 5, Tier 3 capped at 2; perks selectable freely within a tier (no clear-the-column dependency).
>
> **Build-model note:** the original "21 perks, 3 tiers of 7, tier-ceiling unlock" spec is superseded by the above (42 perks across 3 tiers, capacity-based selection). Rework the solver's artifact treatment against this before Phase 1 feasibility. Per-account *unlock state* (which perks a player owns) is in `characterProgressions…seasonalArtifact` (OAuth, Phase 2) — not needed for the all-content dataset.

### The load-bearing derived layer — keyword tagging
Every item/perk gets normalized tags at ingestion, e.g.:
```
{ produces: ["volatile"], consumes: ["jolt"], element: "void", triggers: ["ability_kill"] }
```
This is the substrate for **both** the synergy rules **and** the future graph-embedding layer.

### The `Build` object (shared currency across solver, synergy engine, UI)
```
Build {
  subclass: { element, super, aspects[], fragments[] }
  weapons:  [ { slot, itemHash?, perkConstraints[] } x up to 3 ]
  armor: {
    exoticHash?,
    pieces[],          // each carries its setHash
    setBonuses[],      // 2pc/4pc bonuses active, derived from pieces
    statPriorities[],  // DIM-style floors/ceilings per stat
    mods[]
  }
  artifact: { artifactHash?, selectedPerks[] }
  constraints: Constraint[]   // the user's pinned specs
}
```

---

## 3. The Constraint Solver

**Input:** a partial `Build` with pinned `Constraint`s.
**Output:** a completed/coherent build, a set of valid options for open slots, or a clear explanation of *why* infeasible.

Two responsibilities, kept separate:

### 3a. Validation (hard rules)
- Fragment count ≤ aspect-granted slots; element consistency.
- Weapon roll feasibility: requested perks exist in the pool **and can co-occur** (not mutually exclusive in the same column).
- Armor: exactly one exotic; mod energy/slot legality; set-piece counts valid (**≤ 4 with an exotic**, since one of 5 slots is the exotic).
- Artifact: selected perks respect tier-ceiling + active-count rules.
- Champion / anti-barrier coverage where relevant.

### 3b. Completion / search (soft goals)
Fill open slots to satisfy stat priorities and maximize synergy: pinned values fixed, open slots enumerate candidates, prune by hard rules, rank by `stat fit + synergy score`.

### Combinatorics decision
The naive full cross-product is intractable (billions+). We never compute it. It is tamed by:
1. **Constraints prune at the source** — this is a build *completer*, not a "generate all builds."
2. **Synergy is pairwise/keyword-mediated → decompose, don't multiply** (N₁+N₂+N₃+N₄, not N₁×N₂×N₃×N₄).
3. **Perk rolls are membership queries, not enumerations** (kills the biggest multiplier).
4. **Inverted indexes + beam search** — candidate generation is index lookups; keep top-K per dimension.

**Result: no general solver library for v1.** Effective work per query is thousands of scored candidates, not millions of builds.

### The one genuinely combinatorial sub-problem: armor stat optimization
> User goal: *"mimic DIM's loadout optimizer in its stat sliders - pick X stat to have ceilings and floors. This part may get tricky and potentially delayed if needed."*

- Isolated as its own **swappable module** behind the solver interface.
- **v1: port DIM's algorithm** (see §3c). Runs in a **web worker**.
- Designed so a heavier optimizer (e.g. WASM CP-SAT/ILP) could drop in later for *just this module*.

### 3c. DIM reference (verified 2026-07-22)
- **DIM is open source under the MIT license** — legal to adapt/port with attribution preserved. ([github.com/DestinyItemManager/DIM](https://github.com/DestinyItemManager/DIM))
- **The optimizer is client-side (web worker), not an API** — it brute-forces "millions of armor combinations" for the *armor sub-problem only*. This validates our combinatorics boundary. There is no DIM endpoint to call; we **port the algorithm**.
- The **per-stat min/max tier sliders + "ignore stat" + maximize-total** UX and the mod-assignment algorithm (categorize → bucket/artifice assignment → permutation → validation → auto stat mods) are documented:
  - [Loadout Optimizer wiki](https://github.com/DestinyItemManager/DIM/wiki/Loadout-Optimizer)
  - [DeepWiki architecture writeup](https://deepwiki.com/DestinyItemManager/DIM/3.2-loadout-optimizer)
- **Caveat:** port the *concepts + core algorithm*, adapt to the frozen game's stat / set-bonus model; keep the MIT attribution notice.

### Critical design seam
The solver reaches synergy **only** through `scoreSynergy(build)` / `getSynergies(build)`. It never knows whether rules or embeddings sit underneath — keeping the phase-3 ML layer drop-in.

---

## 4. Synergy Engine (v1)

> Direction: *"combo of 1 [rule/keyword] and 2 [curated layer], with potential for 3 [ML] in the future."*

Behind the `getSynergies(build)` / `scoreSynergy(build)` interface:

- **Keyword graph** from ingestion tags: nodes = build elements; directed edges = producer→consumer (X creates Volatile → Y benefits from Volatile); undirected edges for element/trigger matches.
- **Scoring** = weighted sum of satisfied producer→consumer chains, element coherence, trigger alignment, artifact/set-bonus reinforcement.
- **Human-readable "why"** with every score (the tag chain that fired) — **non-negotiable for trust.**
- **Curated overlay** — hand-authored JSON of known combos/weights the keywords can't capture. One-time investment (frozen game).

### The ML question (resolved: phase 3, rules-first with embedding-ready seam)
> User: *"is there any room for some ML here to create a multidimensional embedding space capturing synergies?"* → chose option **1: rules-first, embedding-ready seam.**

Key findings from the discussion, recorded so phase 3 doesn't relearn them:
- **Naive text embeddings are a trap** — they capture *topical* similarity, not *mechanical* synergy. Real synergy is often **producer→consumer** (dissimilar text), and two items that both *produce* the same keyword compete for a slot rather than synergize.
- **Graph embeddings (`node2vec`-style) over the keyword-interaction graph** are the right fit: proximity means *mechanically interacts*, incl. multi-hop chains; needs **no external data**; rides on top of the deterministic layer.
- **Item2vec from real build co-occurrence** is the strongest ML route but needs a build corpus we don't have (would require sourcing from DIM loadouts / light.gg / Mobalytics — a data-acquisition project).
- The v1 **rules layer is the prerequisite** for any embedding work: it provides the labeled ground truth to validate/train against, and the graph is the substrate `node2vec` would embed.

---

## 5. UI Shape (v1)

- **Build canvas** — slots for subclass / weapons / armor / mods / artifact; pin any slot or leave open.
- **Constraint panel** — add specs ("weapon can roll perk X," "Void," "use exotic Y," stat floors/ceilings via DIM-style sliders).
- **Results** — completed/suggested builds ranked by score, each with a synergy "why" breakdown and feasibility status.
- **Ownership toggle** — wired but inert until phase 2 (OAuth).

---

## 6. Phased Build Plan

1. **Phase 0 — Ingestion & dataset.** Pull Manifest once, extract buildcrafting slice, compute keyword tags + indexes, emit versioned dataset. *(Milestone: browsable data.)*
2. **Phase 1 — Feasibility validator.** Hard-rule validation over a `Build`.
3. **Phase 2 — Synergy engine + completion/beam search.** The core value.
4. **Phase 3 — Armor stat optimizer.** Port DIM's worker algorithm + slider UI. *(Most likely to slip — designed to.)*
5. **Phase 4 — Web UI** knitting it together.
6. **Later — OAuth ownership toggle; graph-embedding synergy; LLM.**

---

## Tech Stack

- **Next.js + TypeScript** full-stack (single language/repo).
- **`bungie-api-ts`** for Manifest/API typings.
- Ingestion pipeline as an in-repo script; output = versioned static dataset.
- Armor optimizer in a **web worker** (ported from MIT-licensed DIM).
> User: *"TS/JS full stack. I am quite familiar w the python backend / TS frontend dynamic but want to branch out a little."*

---

## Key Decisions Log

| Decision | Choice | Rationale |
|---|---|---|
| Data freshness | Static one-time ingestion, no runtime DB | Game is frozen |
| Storage | Derived JSON dataset (SQLite as fallback) | Buildcrafting slice is small; keeps hosting static |
| Content scope | All game content in v1; ownership toggle later | Theorycrafting first, personalization phase 2 |
| Solver | Decompose + inverted indexes + beam search | Avoids intractable full cross-product; no solver lib |
| Armor stats | Isolated module; port DIM (MIT); web worker | Only genuinely combinatorial sub-problem |
| Synergy v1 | Keyword graph + curated overlay | Explainable, trustworthy, frozen game = one-time curation |
| Synergy future | `node2vec` graph embeddings behind `getSynergies()` seam | Rides on rules layer; no external data needed |
| Artifact | First-class dimension; pinnable or solver-selected | Significant build input |
| Armor sets | Set identity per piece; 2pc/4pc bonuses tracked | Global build perks |
