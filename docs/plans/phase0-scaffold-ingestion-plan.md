# D2Synergy — Phase 0: Project Scaffold + Manifest Ingestion Pipeline

## Context

D2Synergy is a Next.js/TypeScript web app for **constraint-based Destiny 2 buildcrafting** over the game's now-**frozen** Manifest (full design: `docs/designs/2026-07-22-d2synergy-buildcrafting-design.md`). The user specifies partial build constraints ("Void Warlock, use Contraverse Hold, a hand cannon that can roll Explosive Payload"); the tool validates feasibility and suggests synergies.

Because the game receives no more updates, the data never churns — so the architecture (Approach B) is a **one-time ingestion pipeline** that downloads the Manifest once, slims it to a buildcrafting-focused slice, pre-computes keyword tags + indexes, and commits a **versioned derived dataset** to the repo. The app reads that static dataset; no runtime DB.

**Phase 0 is the foundation everything else depends on.** It delivers (1) the scaffolded Next.js/TS project and (2) the ingestion pipeline that produces the committed derived dataset. It does *not* build the solver, synergy scoring, or UI (later phases). Success = a browsable, typed, committed dataset + a project skeleton later phases extend.

Prerequisite (user handling): registering a Bungie app at bungie.net/developer for an `X-API-Key`. Redirect URL must use `https://127.0.0.1:3000/...` (Bungie rejects `localhost` and plain http) — only relevant for the Phase 2 OAuth flow, not Phase 0.

## Decisions locked in brainstorming/research
- **Scope:** all game content (pure Manifest); ownership/OAuth is Phase 2.
- **Storage:** derived dataset committed to git (SQLite is a documented fallback if JS querying gets painful — keep the data-access layer clean so it can graduate later).
- **Manifest access:** per-component JSON via `bungie-api-ts` `getDestinyManifestSlice`; `X-API-Key` only.
- **Energy affinity:** ignored (Armor 3.0 untyped armor).
- **Keywords:** scraped from sandbox-perk/item descriptions; curated overlay layered on (frozen game = one-time).

## Defaults chosen (flag for approval — all easily changed)
- Package manager: **pnpm** (what DIM uses).
- Styling: **Tailwind CSS** (App Router, TS strict).
- Test/validation: **Vitest** for dataset smoke-assertions.

## Project structure
```
D2Synergy/
  src/
    app/                      # Next.js App Router (UI stub only in Phase 0)
    lib/
      data/                   # data-access layer: typed loaders for the derived dataset
      types/                  # shared derived-entity + Build types
      synergy/                # getSynergies()/scoreSynergy() interface STUB (seam for Phase 2/3)
  scripts/
    ingest/
      fetchManifest.ts        # version check + getDestinyManifestSlice download
      classify.ts             # resolve itemCategory/socketCategory/plugCategoryIdentifier
      transform.ts            # raw defs -> derived entities
      keywords.ts             # keyword vocabulary + produce/consume tagging
      indexes.ts              # build inverted indexes
      emit.ts                 # write versioned dataset to data/
      run.ts                  # orchestrator (pnpm ingest)
  data/                       # COMMITTED derived dataset (versioned JSON) + dataset-meta.json
  docs/designs/               # design doc (exists)
  .env.example                # documents BUNGIE_API_KEY (+ future CLIENT_ID/SECRET)
  .env.local                  # untracked; real key
```

## Implementation steps

### 1. Scaffold
- `create-next-app` (TS, App Router, Tailwind, pnpm, ESLint). Set `tsconfig` strict.
- Add dependency **`bungie-api-ts`**; dev deps `tsx` (run TS scripts), `vitest`.
- `package.json` scripts: `ingest` (`tsx scripts/ingest/run.ts`), `dev` (with `--experimental-https` note for Phase 2), `test`.
- `.env.example` with `BUNGIE_API_KEY=`; ensure `.env.local` gitignored. Minimal landing page stub confirming the app boots.

### 2. Manifest fetch (`fetchManifest.ts`)
- `$http` wrapper: `fetch` adding `X-API-Key` header from `process.env.BUNGIE_API_KEY`.
- `getDestinyManifest($http)` → read `.version`; compare to `data/dataset-meta.json`. Skip re-download if unchanged (unless `--force`).
- `getDestinyManifestSlice($http, { destinyManifest, tableNames, language: 'en' })` for the tables below.

**Tables to pull (buildcrafting slice):**
`DestinyInventoryItemDefinition`, `DestinyPlugSetDefinition`, `DestinySocketTypeDefinition`, `DestinySocketCategoryDefinition`, `DestinyStatDefinition`, `DestinyStatGroupDefinition`, `DestinyDamageTypeDefinition`, `DestinySandboxPerkDefinition`, `DestinyInventoryBucketDefinition`, `DestinyItemCategoryDefinition`, `DestinyEquipableItemSetDefinition`, `DestinyArtifactDefinition`.

### 3. Classification (`classify.ts`)
- Resolve constants **from the manifest at build time**, not hardcoded: build lookup maps from `DestinyItemCategoryDefinition` (Weapon=1, Armor=20 reliable; others resolved by name), `DestinySocketCategoryDefinition` (names: WEAPON PERKS / ARMOR MODS / ABILITIES / ASPECTS / FRAGMENTS), and `plug.plugCategoryIdentifier` strings (`fragments`, `aspects`, `intrinsics`, …).
- Reference DIM's `src/app/search/d2-known-values.ts` for any constant that can't be resolved cleanly.

### 4. Transform to derived entities (`transform.ts`)
Normalize into compact typed entities (types in `src/lib/types/`):
- **Subclasses** — from Subclass bucket items; group sockets by category into super/abilities/aspects/fragments.
- **Aspects** — plug items; extract **fragment-slot count** from the aspect's `investmentStats` (⚠️ verify the exact `statTypeHash` against manifest/DIM during impl — flagged unknown).
- **Fragments** — plug items; capture stat penalties/bonuses from `investmentStats`.
- **Weapons** — archetype/frame, slot (bucket), `damageType`, and **perk pools** from each `socketEntries[].randomizedPlugSetHash` → `DestinyPlugSetDefinition.reusablePlugItems[]`, filtered by `currentlyCanRoll`. Preserve **column structure** so "can roll X and Y in the same column" is answerable.
- **Armor** — exotic vs legendary (`inventory.tierType`), slot, stat groups, mod sockets, and **set identity** (armor-set linkage added 2025-07-15).
- **Armor sets** — `DestinyEquipableItemSetDefinition`: `setItems[]` + `setPerks[]` (`requiredSetCount` 2/4 → `sandboxPerkHash`).
- **Mods** — armor mods with energy cost (note: untyped post–Armor 3.0).
- **Artifacts** — all **7** `DestinyArtifactDefinition`: `tiers[] × items[]` matrix → perk mods (each `itemHash` → item def).
- **Perks/effects** — `DestinySandboxPerkDefinition` text + referenced item descriptions.

### 5. Keyword tagging (`keywords.ts`)
- Seed a **keyword vocabulary** (Volatile, Jolt, Ignition/Scorch, Restoration, Devour, Radiant, Amplified, Woven Mail, Frost Armor, Cure, etc.).
- Scan sandbox-perk + fragment/aspect/mod/weapon-perk descriptions; emit normalized tags per entity: `{ produces[], consumes[], element, triggers[] }`.
- Distinguish **produce vs consume** heuristically from description phrasing (this is the load-bearing substrate for synergy + future graph embeddings). Leave the curated *weighting/combo* overlay to Phase 2 — Phase 0 only emits the raw tags + a seed `data/curated/keywords.json` scaffold.
- Note in code: authoritative descriptions can later blend the community **Clarity** dataset (deferred).

### 6. Inverted indexes (`indexes.ts`)
Precompute for fast candidate generation later: `keyword → producers`, `keyword → consumers`, `perk → weapons whose pool contains it`, `element → items`, `set → pieces`, `exotic → class/slot`.

### 7. Emit (`emit.ts`)
- Write compact JSON per entity type to `data/` (e.g. `weapons.json`, `armor.json`, `armor-sets.json`, `subclasses.json`, `aspects.json`, `fragments.json`, `mods.json`, `artifacts.json`, `perks.json`, `keyword-index.json`).
- Write `data/dataset-meta.json` (manifest `version`, ingest timestamp passed in, entity counts).

### 8. Data-access layer + synergy seam
- `src/lib/data/`: typed loaders returning the derived entities (single import surface for later phases).
- `src/lib/synergy/`: **stub** `getSynergies(build)` / `scoreSynergy(build)` returning empty/zero — establishes the interface so Phase 2's engine (and Phase 3 embeddings) drop in without touching callers.

## Key files to create
- `scripts/ingest/*.ts` (pipeline above)
- `src/lib/types/*.ts` (derived-entity + `Build` types from the design)
- `src/lib/data/index.ts` (loaders)
- `src/lib/synergy/index.ts` (interface stub)
- `data/*.json` (generated, committed)
- `.env.example`, updated `package.json`, `tsconfig.json`

## Reuse (don't reinvent)
- `bungie-api-ts` — all Manifest types + `getDestinyManifest`/`getDestinyManifestSlice`.
- DIM `src/app/search/d2-known-values.ts` & `d2-additional-info` repo — hash constants and rich-text mappings, as reference.
- Community **Clarity** dataset — deferred source for authoritative keyword descriptions.

## Verification
1. **Run pipeline:** `BUNGIE_API_KEY=... pnpm ingest` completes and writes `data/*.json` + `dataset-meta.json`. Orchestrator prints entity counts.
2. **Vitest smoke assertions** over the emitted dataset:
   - Exactly **7 artifacts**, each with 3 tiers and 7 items per tier (per user's spec — assert and flag if the manifest disagrees).
   - Weapons have non-empty, column-structured perk pools; spot-check a known weapon by name has an expected perk in the right column.
   - Aspects report a fragment-slot count > 0; fragments carry stat modifiers.
   - Armor sets expose `requiredSetCount` 2 and 4 perks resolving to real sandbox-perk text.
   - Every emitted entity that grants a known keyword has a non-empty `produces`/`consumes` tag.
3. **App boots:** `pnpm dev` serves the stub landing page; `src/lib/data` loaders import and read the committed dataset without error.
4. **Re-run is a no-op:** second `pnpm ingest` detects unchanged `version` and skips (unless `--force`).

## Flagged unknowns to resolve during implementation
- Exact `statTypeHash` encoding an aspect's fragment-slot count (verify vs manifest/DIM).
- Confirm the armor→set linking field name on `DestinyInventoryItemDefinition`.
- Confirm the 7-artifacts / 3-tiers / 7-per-tier shape holds in the live manifest; adjust assertions if not.
- Measure actual `data/` size to decide if plain git is fine or Git LFS is warranted.
```
