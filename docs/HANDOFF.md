# D2Synergy — Session Handoff

> Single resume point for in-flight work. A fresh session in this repo (`/home/doc/Desktop/Repos/D2Synergy`) reads this file first, then the docs it points to, and continues cold.

## Where we are
**Phase 1 (feasibility validator) — IN PROGRESS via subagent-driven execution. Branch `phase1-validator`; last CODE commit `00969e0` (tip is a docs/handoff commit on top). Tasks 1–3 of 7 done + reviewed clean. NEXT: Task 4 (weapon rules).** Phase 0 (scaffold + ingestion) shipped to `main`.

## Doc pointers
- **Execution source-of-truth:** `docs/superpowers/plans/2026-07-23-phase1-feasibility-validator.md` (the Phase 1 plan; 7 tasks with full code). **When plan and design disagree, the plan wins for Phase 1 scope.**
- **Phase 1 spec:** `docs/superpowers/specs/2026-07-23-phase1-feasibility-validator-design.md`.
- **Design / architecture (the "why"):** `docs/designs/2026-07-22-d2synergy-buildcrafting-design.md`.
- **SDD progress ledger:** `.superpowers/sdd/progress.md` — git-ignored scratch that **persists on disk** across sessions. On resume, `cat` it: tasks marked complete there are DONE — do not re-dispatch. Trust it + `git log` over recollection. (Task briefs + review packages also live under `.superpowers/sdd/`.)

## Past / done
**Phase 0 — ✅ shipped to `main`** (scaffold, ingestion pipeline, committed 4.5 MB dataset, 7 artifacts). Details in git history + design doc.

**Phase 1 (branch `phase1-validator`, 6 commits ahead of `main`):**
| Task | Status |
|---|---|
| T1 — `ammoType` on Weapon + **dummy-item exclusion** in `classify.ts` | ✅ `6b2632a` (reviewed) |
| T2 — validation core (`src/lib/validation/` types, `createLookup`, `validateBuild`) | ✅ `df73844` (reviewed) |
| T3 — subclass rules (`subclass.ts`) | ✅ `00969e0` (reviewed) |
| T4 — weapon rules (`weapons.ts`) | ⏭️ **NEXT** |
| T5 — armor rules · T6 — artifact rules · T7 — register + integration test | pending |

**Test baseline:** `pnpm test` → **18/18 pass** (3 files: `dataset.smoke`, `validation/core`, `validation/subclass`); `pnpm exec tsc --noEmit` clean; `pnpm exec eslint scripts src tests` clean. Working tree clean at `00969e0`.

## Active / next — Task 4: Weapon rules (start here)
Create `src/lib/validation/weapons.ts` (exports `weaponRules: Rule[]`) + `tests/validation/weapons.test.ts`. **Full code is in the plan's Task 4.** Rules:
- `PERK_NOT_IN_POOL` — a requested perk isn't in the pinned weapon's `perkColumns`.
- `PERK_COLUMN_CONFLICT` — two requested perks resolve to the same single column.
- `WEAPON_SLOT_MISMATCH` — pinned weapon's real `slot` ≠ the selection's declared slot.
- `DUPLICATE_WEAPON_SLOT` — two weapons in the same slot.
- `DOUBLE_PRIMARY_AMMO` — both non-Power weapons are Primary ammo (need ≥1 Special; **double-Special is allowed**). Fires only when both non-Power slots are set. Uses `Weapon.ammoType` (added in T1).

**Proves it done:** `tests/validation/weapons.test.ts` passes — 6 cases, incl. "flags double-primary" AND "allows a special in the mix". All violations `category: "game"`. `pnpm test` stays green; tsc clean.

**Base commit for T4 review = current HEAD** (`git rev-parse --short HEAD` — the docs/handoff tip, so the review diff excludes doc commits).

## Resume procedure (subagent-driven)
1. `cat .superpowers/sdd/progress.md`; confirm `git log` matches (HEAD `00969e0`, on `phase1-validator`).
2. Re-enter `superpowers:subagent-driven-development`. For each remaining task N (4→7):
   - `scripts/task-brief <plan> N` → brief file; dispatch implementer (**model `haiku`** — briefs carry full code; TDD).
   - On DONE: `scripts/review-package <BASE> <HEAD>` → dispatch task reviewer (**model `sonnet`**). For commits that regenerate `data/`, hand a code-scoped diff (`git diff -U10 BASE..HEAD -- . ':(exclude)data/'`) — the raw `data/*.json` diff is huge.
   - Fix loop on Critical/Important; record Minor in the ledger; append `Task N: complete (…, review clean)` to the ledger.
   - Scripts dir: `/home/doc/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1/skills/subagent-driven-development/scripts`.
3. After T7: final whole-branch review (most-capable model, `MERGE_BASE=$(git merge-base main HEAD)`), then `superpowers:finishing-a-development-branch` → merge `phase1-validator` → `main`.

## Future / parked (in order)
- T5 armor rules, T6 artifact rules, T7 register `ALL_RULES` + real-dataset integration test.
- Then final review → merge to `main`.
- **Phase 2:** synergy engine + completion/beam search (populates the `policy` violation category + the `getSynergies`/`scoreSynergy` stubs).
- **Before Phase 2 solver work:** rework the artifact build-model to the real structure (see Decisions).
- **Explicitly deferred (do NOT build now):** champion/anti-barrier coverage (text-only data, needs extraction pass); one-exotic-*weapon* rule (needs a `tier` field on Weapon, not emitted); mod energy legality (deprecated); OAuth ownership (Phase 2); graph-embedding synergy (Phase 3).

## Decisions resolved (do not relitigate)
- **Phase 1 validator = rule registry + DI.** Each rule is a pure `(build, lookup) => Violation[]`, grouped per domain, concatenated by `validateBuild`. Rules depend on a narrow `Lookup` seam (not the dataset) so unit tests inject stubs — no filesystem. *Why:* isolated/testable, mirrors the ingestion's small-module style.
- **Violation `category`: `game` vs `policy`.** All v1 rules are `game` (hard → `valid=false`). `policy` is reserved for Phase 2 soft/synergy preferences (rank, don't invalidate). *Why:* clean seam without a fake split now.
- **Partial-build semantics:** an incomplete build is never "invalid"; each rule has a *firing condition* (fires only once its section is engaged). *Why:* a build canvas mid-edit shouldn't be spammed.
- **User's baseline constraints enforced as `game` floors** pairing with game ceilings → pinned values: aspects **=2**, fragments **=max**, exotic armor **=1**, artifact tiers filled to `slots`. Ammo: **no double-primary; double-special allowed** (≥1 Special). *Why:* common-sense build requirements that also prune the Phase 2 solver.
- **Dummy items excluded from classification.** Manifest has dummy weapon/armor copies (itemCategory "Dummies", `itemType` 20) with bogus data (e.g. dummy Jade Rabbit = Heavy ammo, Kinetic slot). `classify.ts` `isDummy` rejects them → weapons 2481→2208, armor 7551→6029, and "non-Power weapons are never Heavy" holds. *Why:* real data-quality bug, not an exception to the rule.
- **Artifacts (CORRECTED):** 7 artifacts sourced from `DestinyInventoryItemDefinition` "Artifact" items (bucket `1506418338`, 8 sockets) — NOT `DestinyArtifactDefinition` (returns only current). Each: **3 tiers, perk pools 7/14/21, per-tier selection ceiling 2/3/2 = 7 equipped, no duplicates** (`ArtifactTier.slots` carries the ceiling). *Supersedes the old "7×3×7 / 21-perk" model.* Rework the solver's artifact treatment to this before Phase 2.
- **(Phase 0, still binding):** Approach B static ingestion committed to git; `bungie-api-ts` + `getDestinyManifestSlice`, `X-API-Key` only; energy affinity ignored; synergy rules-first w/ embedding-ready seam; solver = decompose + inverted indexes + beam search (armor-stats = swappable DIM port). Names: repo `D2Synergy`, npm `d2synergy`.

## Process + gotchas
- **SDD models:** implementers `haiku` (briefs carry full code = transcription+TDD); task reviewers `sonnet`; final whole-branch review = most-capable.
- **Git:** user owns commits but has directed commit-per-task on the branch this session. Each task self-commits per its plan step.
- **`bungie-api-ts` const enums have NO runtime value** (ambient, erased by esbuild) — never use as runtime values; compare numeric literals with a comment (see `DestinyAmmunitionType` map, `itemType===20`).
- **Re-ingest** (`pnpm ingest --force`, only if a task changes the transform) needs `BUNGIE_API_KEY` in `.env` (auto-loaded). **RAM-constrained machine** → run with `NODE_OPTIONS="--max-old-space-size=2048"`; check `free -h` before heavy installs.
- **Open Minor findings for the final review** (recorded in ledger): (1) `transform.ts` `AMMO` record allocated inside the weapon loop — hoist it; (2) `tests/validation/subclass.test.ts` imports unused `describe` (eslint warn).
- **Alias:** shared types import via `@/*` → `src/`; scripts use relative `../../src/lib/types`. `vitest.config.ts` maps `@`.

## Lifecycle
- Keep current: on each task completion, update the status table + "Where we are" + test baseline + ledger.
- **Delete this file** once Phase 1 ships and its detail is in commit history.
