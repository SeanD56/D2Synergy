# D2Synergy — Session Handoff

> Single resume point for in-flight work. A fresh session working **in this repo** (`/home/doc/Desktop/Repos/D2Synergy`) should read this file first, then the docs it points to, and continue cold.
> **Location note:** placed at `docs/HANDOFF.md` for discoverability (no prior handoff convention existed). Redirect if you'd prefer `docs/designs/`.

## Where we are
**Phase 0 (scaffold + Manifest ingestion) — ✅ COMPLETE and merged to `main` (2026-07-22).** All 8 tasks done; `pnpm ingest` produces the committed dataset (`data/*.json`, 4.5 MB), `pnpm test` is 8/8 green, `pnpm dev` boots. **NEXT: Phase 1 — feasibility validator** (see design §3a). Before Phase 1, rework the artifact build-model per the ingestion finding below.

> **✅ RESOLVED — artifact sourcing (research spike + rework, 2026-07-22):**
> All **7 artifacts** now ingest correctly. They are NOT in `DestinyArtifactDefinition` (returns only the current one); they're `DestinyInventoryItemDefinition` items with `itemTypeDisplayName: "Artifact"` in the Artifacts bucket (`1506418338`), each with 8 sockets. `transformArtifacts` sources them via `classifier.isArtifact`; `DestinyArtifactDefinition` was dropped from the fetched slice. Emitted: 7 artifacts × 3 tiers, perk pools 7/14/21. See design doc §2 for the full model + in-game slot-capacity rules.
>
> **Before Phase 1:** rework the solver's artifact build-model against the real structure (42 perks across 3 tiers, capacity-based selection 7/5/2 — not the old "21 perks, 3×7, tier-ceiling").

## Doc pointers
- **Execution source-of-truth:** `docs/plans/phase0-scaffold-ingestion-plan.md` (the approved Phase 0 plan; also lives at `~/.claude/plans/soft-launching-nebula.md`). **When this and the design doc disagree, the plan wins for Phase 0 scope.**
- **Design / architecture (the "why"):** `docs/designs/2026-07-22-d2synergy-buildcrafting-design.md` — full product design, build model, solver/synergy architecture, phased roadmap, decisions log.

## Past / done
| Item | Status |
|---|---|
| Brainstorming + product design | ✅ `docs/designs/2026-07-22-...-design.md` |
| Bungie API app registered (by user) | ✅ app name **D2SynergySite**, Confidential client, redirect `https://127.0.0.1:3000/api/auth/callback`, scopes: Read D2 info + Move/equip. **API key / client id / secret held by user — NOT in repo.** |
| Phase 0 plan approved | ✅ `docs/plans/phase0-scaffold-ingestion-plan.md` |
| Manifest research (tables, auth, tooling) | ✅ folded into the plan's steps + "Flagged unknowns" |
| Task 1 — Scaffold Next.js/TS | ✅ Next 16 + TS strict + Tailwind v4 + pnpm; scripts `ingest`/`test`/`dev:https`; `.env.example`; landing stub. |
| Task 2 — Types | ✅ `src/lib/types/` (entities, Build, dataset, common). |
| Task 3 — Manifest fetch | ✅ `scripts/ingest/fetchManifest.ts` (X-API-Key HttpClient, version check, 12-table slice). |
| Task 4 — classify + transform | ✅ `classify.ts` + `transform.ts`. |
| Task 5 — keywords + indexes | ✅ `keywords.ts` (seed vocab + produce/consume tagger) + `indexes.ts`; `data/curated/keywords.json` seed. |
| Task 6 — emit + run | ✅ `emit.ts` + `run.ts` (`--force`, count report). |
| Task 7 — loaders + synergy stub | ✅ `src/lib/data/` + `src/lib/synergy/` (getSynergies/scoreSynergy stubs). |
| Task 8 — tests + real ingest | ✅ 8/8 Vitest smoke tests; real ingest run; no-op re-run verified. |

**Test baseline:** `pnpm test` → 8/8 pass. App-boot: `pnpm dev` (HTTP 200 on stub). Ingest: `pnpm ingest` (needs `BUNGIE_API_KEY` in `.env` or `.env.local`).

## Active / next — Task 1: Scaffold (start here)
Build the project skeleton in the repo. Files/artifacts:
- Run `create-next-app` (TS, App Router, Tailwind, `--src-dir`, `--eslint`, `--use-pnpm`, `--import-alias "@/*"`, `--turbopack`). **GOTCHA:** npm rejects capital letters, so the project name can't be `D2Synergy`. Scaffold into a temp dir named `d2synergy` then copy files into the repo (exclude `.git`, `node_modules`), OR scaffold in place and hand-set `package.json` `"name": "d2synergy"`. Preserve the existing `docs/`.
- Add dep **`bungie-api-ts`**; dev deps **`tsx`**, **`vitest`**. Set `tsconfig` strict.
- `package.json` scripts: `ingest` → `tsx scripts/ingest/run.ts`, `test` → `vitest`, `dev` (note `--experimental-https` needed later for Phase 2 OAuth on `127.0.0.1:3000`).
- `.env.example` documenting `BUNGIE_API_KEY=` (+ future `BUNGIE_CLIENT_ID`/`SECRET`); confirm `.env.local` is gitignored.
- Minimal landing-page stub.

**Done when:** `pnpm install` succeeds, `pnpm dev` serves the stub page, `package.json` name is lowercase, `docs/` still intact. (Watch for OOM during install — the earlier run was killed exit 137; if it recurs, run `pnpm install` separately / limit concurrency.)

## Future / parked (in order)
- **Task 2** — Derived-entity + `Build` types (`src/lib/types/`).
- **Task 3** — Manifest fetch (`scripts/ingest/fetchManifest.ts`): `$http` w/ `X-API-Key`, version check vs `data/dataset-meta.json`, `getDestinyManifestSlice` for the 12 tables (listed in plan §2).
- **Task 4** — `classify.ts` + `transform.ts` (raw defs → derived entities).
- **Task 5** — `keywords.ts` (produce/consume tagging) + `indexes.ts` (inverted indexes).
- **Task 6** — `emit.ts` + `run.ts` (write versioned `data/*.json` + `dataset-meta.json`; `--force` flag; count reporting).
- **Task 7** — `src/lib/data/` loaders + `src/lib/synergy/` interface **stub** (`getSynergies`/`scoreSynergy`).
- **Task 8** — Vitest smoke tests + run `pnpm ingest` with user's key; confirm boot + no-op re-run.

**Explicitly deferred (do NOT build now):** OAuth "what I own" toggle (Phase 2), graph-embedding synergy layer (Phase 3), LLM reasoning, Clarity dataset blend for keyword text, SQLite storage fallback.

## Decisions resolved (do not relitigate)
- **Architecture = Approach B:** one-time static ingestion → versioned derived dataset **committed to git**; no runtime DB. *Why:* game is frozen (no more updates), so data never churns.
- **Stack:** Next.js App Router + TS strict + Tailwind + **pnpm** + Vitest. *Why:* single-language JSON-native stack; pnpm matches DIM.
- **Manifest access:** `bungie-api-ts` + `getDestinyManifestSlice` (per-component JSON), `X-API-Key` only for Phase 0 (no OAuth). *Why:* pull only the ~12 buildcrafting tables, already typed.
- **Energy affinity ignored** (Armor 3.0 untyped armor). *Why:* deprecated mechanic.
- **Synergy = rules-first (keyword produce/consume + curated overlay), embedding-ready seam** behind `getSynergies()`/`scoreSynergy()`. *Why:* explainable/trustworthy v1; rules provide ground truth for a later `node2vec` graph-embedding layer (Phase 3, chosen over text embeddings which capture topical not mechanical synergy).
- **Solver = decompose + inverted indexes + beam search, no solver library.** Armor stat-tier optimization isolated as a **swappable module**, v1 = port **DIM's MIT-licensed web-worker algorithm** (keep attribution). *Why:* full cross-product is intractable but synergy is pairwise/keyword-mediated; only armor-stats is genuinely combinatorial.
- **Build model** includes **artifact** (7 artifacts, 3 tiers × 7 perks, tier-ceiling + active-count, pinnable or solver-selected) and **armor set bonuses** (2pc/4pc). *Why:* both are significant build inputs per the user.
- **Names:** repo dir `D2Synergy`, Bungie app `D2SynergySite`, npm package **`d2synergy`** (lowercase forced by npm).

## Process + gotchas
- **Git:** user owns all commits. Nothing committed yet — suggest an initial commit after scaffold lands. Currently on `main`.
- **Bungie gotchas:** redirect URL must be `https://127.0.0.1:3000/...` (Bungie rejects `localhost` and plain `http`); Phase 2 dev server must run HTTPS via `next dev --experimental-https`; API key goes in untracked `.env.local`.
- **create-next-app gotcha:** capital-letter project name is rejected (see Task 1). Node 22.15, pnpm 10.32 confirmed.
- **Ephemeral temp scaffold** at `<session scratchpad>/d2synergy` — do NOT depend on it; re-scaffold fresh.
- **Flagged unknowns to verify at source during impl (from research):**
  1. Exact `statTypeHash` encoding an aspect's fragment-slot count (check manifest / DIM `d2-known-values.ts`).
  2. The armor→set linking field name on `DestinyInventoryItemDefinition`.
  3. That the 7-artifacts / 3-tiers / 7-per-tier shape holds in the live manifest (adjust Vitest assertions if not).
  4. Measure `data/` size after ingest → decide plain git vs Git LFS.
- **Reuse (don't reinvent):** `bungie-api-ts` types/helpers; DIM `src/app/search/d2-known-values.ts` + `d2-additional-info` repo for hash constants; Clarity dataset (deferred) for keyword text.

## Lifecycle
- **Keep current:** on each task completion, update the status table, "Where we are" line, and test baseline.
- **Delete this file** once Phase 0 ships and its detail is folded into a changelog/commit history.
