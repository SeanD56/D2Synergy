# D2Synergy — Session Handoff

> Single resume point for in-flight work. A fresh session in this repo (`/home/doc/Desktop/Repos/D2Synergy`) reads this file first, then the docs it points to, and continues cold.

## Where we are
**Phase 1 (feasibility validator) — ✅ SHIPPED to `main`** (merged from `phase1-validator`).
**Phase 2 · SP1 (synergy engine) — ✅ SHIPPED to `main`** (merged from `phase2-synergy-engine`). Whole-branch reviewed; one Important correctness fix (element dedup) applied. Baseline at merge: **63/63 tests pass**, `tsc --noEmit` clean, `eslint scripts src tests` clean.

**NEXT ACTION:** start SP2 — invoke `superpowers:brainstorming` for the artifact build-model rework (no spec/plan exists yet), then writing-plans → subagent-driven-development, same flow as SP1.

Phase 2 was decomposed into sub-projects (see design doc / SP1 spec). Order + status:
- **SP1 — synergy engine** ✅ shipped.
- **SP2 — artifact build-model rework** ⏭️ NEXT (prerequisite before the solver). Rework `Build.artifact` (flat `selectedPerkHashes`) to a per-tier/socket structure + exact per-socket capacity validation. See Decisions → Artifacts and the Phase-1 `tierCapacity` partial-check note.
- **SP3 — completion / beam-search solver** (needs SP1 + SP2). Ranks completions by stat-fit + `scoreSynergy`.
- **SP4 — armor stat optimizer** (DIM-algorithm port, web worker; explicitly delayable).

## Doc pointers
- **Phase 2 · SP1 spec:** `docs/superpowers/specs/2026-07-23-phase2-synergy-engine-design.md`; **plan:** `docs/superpowers/plans/2026-07-23-phase2-synergy-engine.md`.
- **Phase 1 spec/plan:** `docs/superpowers/specs/2026-07-23-phase1-feasibility-validator-design.md` · `docs/superpowers/plans/2026-07-23-phase1-feasibility-validator.md`.
- **Design / architecture (the "why"):** `docs/designs/2026-07-22-d2synergy-buildcrafting-design.md`.
- **Validator code:** `src/lib/validation/` — `types.ts` (Violation/Lookup/Rule), `lookup.ts` (`createLookup`, now incl. `perk`/`mod`/`artifactPerk`), `index.ts` (`ALL_RULES`, `validateBuild`), per-domain rules. Tests in `tests/validation/`.
- **Synergy code:** `src/lib/synergy/` — `types.ts`, `elements.ts` (`collectBuildElements`), `graph.ts` (`matchChains`/`triggerSynergies`), `weights.ts`, `score.ts` (`getSynergies`/`scoreSynergy`), `rules.ts` (`synergyRules`), `index.ts` (`allRules` = game + synergy). Tests in `tests/synergy/`.

## Phase 2 · SP1 — what shipped
Pure, DI'd rules-based synergy engine over the keyword-tag substrate. `getSynergies(build, lookup)` / `scoreSynergy(build, lookup)` fill the seam; `score == Σ synergy weights`. Producer→consumer chains with escalating (quadratic-in-depth) weights reward focus/"engine" builds; element-coherence multiplier; capped trigger alignment; empty curated-overlay mechanism. Soft `policy` advisories (`UNUSED_PRODUCER`/`UNMET_CONSUMER`) via `synergyRules`, never flipping `valid`. `Lookup` extended with `perk`/`mod`/`artifactPerk`. Open follow-ups: author curated-overlay entries; weapon roll resolution for name-only perk constraints (SP3); tune weights vs real builds; prismatic-subclass alignment nuance.

## Phase 1 — what shipped
Rule-registry + DI validator: each rule is a pure `(build, lookup) => Violation[]`, grouped per domain, concatenated by `validateBuild`; `valid = false` iff any `game`-category violation. Rules depend on a narrow `Lookup` seam (not the dataset) so unit tests inject stubs — no filesystem. Domains + codes: subclass (aspect/fragment limits, element match), weapons (perk-in-pool, column conflict, slot mismatch, duplicate slot, no-double-primary), armor (exotic count 0/1, class match, duplicate slot, set-bonus counts), artifact (perk membership, duplicate, tier capacity). Also: `ammoType` on Weapon; dummy manifest items excluded from classification.

## Future / parked (in order)
- **SP1 synergy engine** ✅ shipped (the `policy` category + `getSynergies`/`scoreSynergy` are now live). Remaining SP1 follow-ups: author curated-overlay entries; tune weights vs real builds; prismatic-subclass alignment nuance.
- **SP2 — artifact build-model rework (NEXT; carries a known Phase-1 limitation):** the Phase-1 `artifact.ts` `tierCapacity` rule validates only what's soundly checkable from the flat `selectedPerkHashes` list — total count ≤ 7 and a nested-ceiling feasibility guard. It is correct (never rejects a legal build, correctly rejects infeasible ones) but does NOT model per-socket assignment. Rework `Build.artifact` to a per-tier/per-socket selection (or keep the flat list + matching check) so the solver can reason about exact socket placement. See Decisions → Artifacts and memory `artifact-tier-pools-cumulative`.
- **Deferred Minors / follow-ups:** `scripts/ingest/transform.ts` `AMMO` record allocated inside the weapon loop → hoist; `PerkConstraint.column` field defined but unused (reserved); `artifact.ts` `perkMembership` can emit `ARTIFACT_PERK_UNKNOWN` once per repeated occurrence of an unknown hash (cosmetic); Prismatic `elementConsistency` path has no explicit guard and no real-dataset test (likely holds because prismatic plugs tag as `"prismatic"`, but add a targeted test).
- **Explicitly deferred (do NOT build now):** champion/anti-barrier coverage (text-only data, needs extraction pass); one-exotic-*weapon* rule (needs a `tier` field on Weapon, not emitted); mod energy legality (deprecated); OAuth ownership (Phase 2); graph-embedding synergy (Phase 3).

## Decisions resolved (do not relitigate)
- **Phase 1 validator = rule registry + DI.** Pure `(build, lookup) => Violation[]` rules grouped per domain, concatenated by `validateBuild`; narrow `Lookup` seam so unit tests inject stubs. *Why:* isolated/testable, mirrors ingestion's small-module style.
- **Violation `category`: `game` vs `policy`.** All v1 rules are `game` (hard → `valid=false`). `policy` reserved for Phase 2 soft/synergy preferences (rank, don't invalidate). *Why:* clean seam without a fake split now.
- **Partial-build semantics:** an incomplete build is never "invalid"; each rule has a firing condition (fires only once its section is engaged). Empty/unselected rows never fire (guarded in weapon slot-uniqueness + perk constraints, armor slot-uniqueness, artifact pinning). *Why:* a build canvas mid-edit shouldn't be spammed.
- **User's baseline constraints as `game` floors** pairing with game ceilings → aspects **=2**, fragments **=max**, exotic armor **=1**, artifact tiers filled to `slots`. Ammo: **no double-primary; double-special allowed** (≥1 Special). *Why:* common-sense requirements that also prune the Phase 2 solver.
- **Dummy items excluded from classification.** Manifest has dummy weapon/armor copies (itemCategory "Dummies", `itemType` 20) with bogus data. `classify.ts` `isDummy` rejects them → weapons 2481→2208, armor 7551→6029, and "non-Power weapons never Heavy" holds. *Why:* real data-quality bug.
- **Artifacts — CEILING/cumulative model (CONFIRMED by user 2026-07-23).** 7 artifacts from `DestinyInventoryItemDefinition` "Artifact" items (bucket `1506418338`, 8 sockets), NOT `DestinyArtifactDefinition`. **3 tiers, socket ceilings 2/3/2 = 7 equipped, no duplicates.** Tiers are a **ceiling**: a higher-tier socket accepts its own perks **plus every lower tier's perks**, so the derived `perks` pools are **cumulative** (7/14/21) — the same perk hash appears in every tier at/above where it unlocks. Capacity legality from a flat list is a nested feasibility/matching problem, NOT a per-tier count. Phase 1 ships a sound-but-partial check (see Future → artifact rework). Memory: `artifact-tier-pools-cumulative`.
- **(Phase 0, still binding):** Approach B static ingestion committed to git; `bungie-api-ts` + `getDestinyManifestSlice`, `X-API-Key` only; energy affinity ignored; synergy rules-first w/ embedding-ready seam; solver = decompose + inverted indexes + beam search (armor-stats = swappable DIM port). Names: repo `D2Synergy`, npm `d2synergy`.

## Process + gotchas
- **`bungie-api-ts` const enums have NO runtime value** (ambient, erased by esbuild) — never use as runtime values; compare numeric literals with a comment (see `DestinyAmmunitionType` map, `itemType===20`).
- **Re-ingest** (`pnpm ingest --force`, only if a task changes the transform) needs `BUNGIE_API_KEY` in `.env`. **RAM-constrained machine** → `NODE_OPTIONS="--max-old-space-size=2048"`; check `free -h` before heavy installs.
- **Alias:** `@/*` → `src/`; scripts use relative `../../src/lib/types`. `vitest.config.ts` maps `@`.
- **SDD workflow (for future phases):** implementers on a fast/cheap model when the brief carries full code; task reviewers mid-tier; final whole-branch review on the most-capable model. Progress ledger lives at `.superpowers/sdd/progress.md` (git-ignored scratch).

## Lifecycle
- Update this file at the start/end of each working session and phase boundary.
- Safe to trim the Phase-1 detail once Phase 2 is underway; keep Decisions + Future.
