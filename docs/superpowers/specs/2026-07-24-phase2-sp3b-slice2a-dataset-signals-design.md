# Phase 2 · SP3b (slice 2a) — Dataset signals for exotic armor, mods, plugs, champions — design

> Validated design. A **data/ingest slice**, not a solver slice: it exists because SP3b slice 2
> (exotic armor + mods in the solver) is data-blocked. Consumes: the Phase 0 ingestion pipeline
> (`scripts/ingest/`), SP1's keyword-tag substrate. Produces the dataset that **slice 2b** (the solver
> half) will be brainstormed against. Flow: brainstorming (this doc) → writing-plans →
> subagent-driven-development (same as SP1/SP2/SP3a/SP3b-slice-1).

## Why THIS slice, and why now

Slice 2 was planned as "exotic armor + mods in the solver". Investigating it surfaced a blocker of the
same class as slice 1's plug-hash finding, but harder — **exotic armor carries no synergy signal at
all**, so a solver that "chooses the exotic" would be ranking 348 items that all score identically.
Unlike slice 1, no runtime bridge rescues it: the fix is only possible in `scripts/ingest/transform.ts`
plus a re-ingest.

A re-ingest is a rare, deliberately-gated event on this repo (live manifest re-fetch ⇒ unrelated season
churn, plus OOM risk on a RAM-constrained box), so this slice batches **every** signal that can only
land here — including the Option A weapon plug hash-tagging that slice 1 explicitly parked for "the
next legitimate re-ingest", and the champion/anti-barrier extraction pass.

Slice 2b is then brainstormed against measured data instead of predicted data — the failure mode
slice 1 hit mid-plan.

## Data reality (empirically verified against `data/*.json` + `scripts/ingest/`, 2026-07-24)

**Exotic armor has no usable tags.**
- 346 / 348 exotics have empty `tags` (`data/armor.json`).
- `Armor.exoticPerkHash` is emitted at `transform.ts:353` as `item.perks?.[0]?.perkHash`, but **0 / 348**
  exotics actually carry it — armor items' manifest `perks` array is empty. So `itemText(item, perks)`
  scans only flavor text, and the exotic's real effect (which lives behind its `INTRINSIC TRAITS`
  socket) is never read: `transformArmor` walks only `ARMOR MODS` socket categories (`transform.ts:333`).
- The slice-1 trick does not transfer: an armor-name → perk-name bridge hits **2 / 141** distinct
  exotic names, of which **1** is tagged (`Swarmers → produces tangle, unravel`).

**Mods have tags but no placement information.**
- **145 / 512** mods carry non-empty tags — real signal, usable as-is.
- Nothing maps a mod to a socket: `Mod` carries only `energyCost`; armor carries `modSocketHashes`
  (52 distinct socket-type hashes across the corpus). `plugCategoryIdentifier` — read at
  `classify.ts:221` for `plugKind` and then dropped — is the presumed carrier of slot restriction.
  **This is an assumption pending measurement** (see Execution order, step 2); it cannot be confirmed
  from committed data.

**Weapon plug tags are cheap as a side table, expensive inline.**
- **112,486** plug entries across `weapons.json`, but only **1,057 distinct plug hashes** (686 distinct
  names) — plugs repeat heavily across weapons.
- Inline `tags` on `WeaponPerk` ≈ **+7.08MB** on a 5.68MB `weapons.json`. A side table keyed by
  distinct hash ≈ **0.08MB**. Decided in favour of the side table.

**Re-ingest is possible now:** `BUNGIE_API_KEY` present in `.env`; 6.4Gi available RAM (1.6Gi free).
No raw-manifest cache exists on disk (`fetchManifest.ts` fetches live), so the slice fetches once and
measures from that run.

## Decisions (this brainstorm)

1. **Slice 2 splits: 2a (this doc, data) then 2b (solver).** Rather than one combined spec whose solver
   sections are written against predicted yield. 2b's candidate model genuinely depends on 2a's measured
   output (how many exotics end up tagged, whether mod slot restriction resolves cleanly, what the churn
   did to the weapon pool).

2. **Ingest-first, not mods-only-now.** The alternative — ship a mods-only slice 2 against the 145
   tagged mods with an over-permissive flat-pool placement model, leaving exotics pinned-only — was
   rejected: it leaves the primary buildcrafting anchor ("use X exotic", the user's own framing of the
   product) unsolved and bakes in a placement model we would later replace.

3. **Ride-alongs: Option A weapon plug tags, and champion/anti-barrier extraction.** Both can only land
   in a re-ingest. **Explicitly declined for this slice:** a `tier` field on `Weapon` (would unblock the
   deferred one-exotic-weapon rule) and the parked `AMMO`-record hoist — they stay parked.

4. **Weapon plug tags ship as a side table `data/plug-tags.json`** (`Record<Hash, KeywordTags>`, entries
   only where tags are non-empty), not as an inline `WeaponPerk.tags` field. Measured 88× size
   difference (above). This also retires the hash asymmetry flagged at `candidates.ts:127-129`: a plug's
   hash resolves to its tags directly, so move identity and synergy identity coincide, and the
   plug-NAME bridge demotes to a fallback.

5. **Champions are modelled as a distinct `championStuns` field, never as `produces`/`consumes`.**
   Champion stunning is **coverage**, not a producer→consumer chain: stacking three anti-barrier sources
   has zero marginal value. Folding it into `produces` would reward duplicate coverage in the chain
   scorer and spray false `UNUSED_PRODUCER` advisories over every artifact champion mod. The field is
   **optional and omitted when empty**, so existing emitted JSON stays byte-identical where there is
   nothing to say. **2a emits and contract-tests the data; no coverage rule is built** (that is 2b or
   later).

6. **Acceptance = measured coverage floor + curated spot-checks, with a real stop condition.** If the
   exotic tag-coverage floor is not met, the slice **stops and we reassess** rather than shipping dead
   data. Floors are set from the step-2 measurement, not guessed in this doc.

7. **Transform changes and regenerated data go in separate commits**, so a bad dataset reverts with one
   `git revert` without losing the code.

## Scope

**In scope — four signals, one re-ingest:**
1. Exotic armor intrinsic → `tags` populated and `exoticPerkHash` actually emitted.
2. Mod slot restriction → mods placeable per armor slot instead of a flat pool.
3. Weapon plug tags (Option A) → `data/plug-tags.json`, name bridge demoted to fallback.
4. `championStuns` extraction → new coverage field on the tag substrate.

**Out of scope (2b or later):** any solver dimension (exotic selection, mod selection); the champion
**coverage rule** and any scoring that reads `championStuns`; synergy weighting changes; UI. Also still
parked: `Weapon.tier`, the `AMMO` hoist, and everything on the standing deferred list
(one-exotic-weapon rule, mod energy legality, OAuth, graph embeddings).

## Changes by module

### `scripts/ingest/transform.ts` — `transformArmor`
Read the `INTRINSIC TRAITS` socket category using the same pattern `transformWeapons` already applies
at `transform.ts:264`; resolve its plug item; scan `itemText(plug, sandboxPerks)`. Re-source
`exoticPerkHash` from the intrinsic plug's sandbox perk rather than the dead `item.perks?.[0]` read.
Emitted `tags` = union of the existing flavor-text scan (current behavior, preserved) and the intrinsic
scan.

### `scripts/ingest/transform.ts` — `transformMods`
Emit the raw `plugCategoryIdentifier` as `Mod.plugCategory`, plus a derived
`Mod.slotRestriction?: ArmorSlot | "general" | "artifice"`. The raw field is a deliberate escape hatch:
if the identifier taxonomy surprises us, it is diagnosable without another fetch. The mapping itself is
finalized from the step-2 measurement.

### `scripts/ingest/transform.ts` + `emit.ts` — plug tags side table
Collect the distinct plug hashes encountered while building `perkColumns`, tag each plug's text once,
and emit `data/plug-tags.json` as `Record<Hash, KeywordTags>` containing only non-empty entries.
`WeaponPerk` is unchanged.

### `scripts/ingest/keywords.ts`
A `CHAMPION_VOCABULARY` pass (barrier / overload / unstoppable surface phrases) producing
`championStuns` on the tagger output. It participates in **no** producer/consumer cue logic.

### `src/lib/types`
- `KeywordTags` gains `championStuns?: ChampionStun[]`; new
  `type ChampionStun = "barrier" | "overload" | "unstoppable"`. Because the field is optional and the
  tagger omits it when empty, entities with no champion phrases emit exactly the bytes they do today;
  `EMPTY_TAGS` needs no change.
- `Mod` gains `plugCategory: string` and `slotRestriction?: ArmorSlot | "general" | "artifice"`.
- `DerivedDataset` gains `plugTags: Record<Hash, KeywordTags>`.

### `src/lib/data`
`loadPlugTags()` for `plug-tags.json`, wired into `loadDataset()`.

### Wiring so the plug tags are actually reachable (the one place 2a reaches beyond ingest)
- `Lookup.plugTags(hash)` in `createLookup` (`lookup.ts`).
- `collectBuildElements` (`elements.ts:35`) resolves a weapon `perkConstraint` by **plug hash first**
  via `plugTags`, keeping `perk(hash)` and the `perkByName` fallback behind it.
- `beam.ts:118` `resolvePlugTags` switches from name-keyed to hash-keyed; the asymmetry note at
  `candidates.ts:127-129` is removed.

Emitting data that nothing reads would be dead weight, which is why this wiring is in 2a rather than 2b.

## Execution order

1. **TDD the offline pieces first** — champion vocabulary pass and the identifier→slot mapping function,
   against synthetic fixtures. No network, no committed-data dependency.
2. **Inspection run** — a scratchpad script that fetches the manifest slice **once** and writes a
   compact report: distinct mod `plugCategoryIdentifier` values with counts; `INTRINSIC TRAITS` socket
   presence across the 348 exotics with sample texts; a dry-run tag-coverage measurement for exotics and
   plugs. This sets the mod mapping and every acceptance floor from evidence.
3. **Finalize the transform**, then one real
   `NODE_OPTIONS="--max-old-space-size=2048" pnpm ingest --force` (check `free -h` first).
4. **Churn triage** as its own task: run the full suite and classify every failure as legitimate season
   churn (re-baseline, recording old → new values in this doc) or genuine regression (fix).

**Churn watchlist:** SP2's "3 tiers, slots 2/3/2, cumulative pools" assumptions; artifact count 7 (a new
season artifact makes it 8); the 25,000 bound-call ceiling at `integration-weapons.test.ts:93`; the five
curated perk names in `weapon-curated-resolution.test.ts`.

## Test plan

**Offline unit tests (written before the fetch):**
- Champion vocabulary: barrier/overload/unstoppable phrases tag correctly; champion phrases never leak
  into `produces`/`consumes`/`triggers`; absent phrases yield an omitted field.
- Identifier→slot mapping: each known identifier shape maps to its `ArmorSlot`/`general`/`artifice`;
  unknown identifiers yield `undefined` (and retain the raw `plugCategory`).
- Armor intrinsic extraction over a synthetic manifest fixture: intrinsic socket → tags +
  `exoticPerkHash`; union with flavor text; non-exotics unaffected.
- Plug-tags collection: distinct-hash dedup; empty entries omitted.
- `collectBuildElements` hash-first resolution with name fallback preserved.

**New `tests/dataset.contract.test.ts` (real data, floors from step 2):**
- Exotic tag coverage ≥ floor; `exoticPerkHash` populated for ~all exotics.
- Mods carrying `slotRestriction` ≥ floor; every mod carries a non-empty `plugCategory`.
- `plug-tags.json` non-empty with ≥ floor distinct tagged plugs.
- `championStuns` present on ≥ floor entities.
- Artifact structural invariants: 3 tiers, `slots` summing to 7.

**Curated spot-checks:** `Swarmers → tangle, unravel`, plus one exotic per element chosen after
measurement; an artifact `Anti-Barrier *` perk → `barrier`. `weapon-curated-resolution.test.ts`
retargets from the name path to the plug-hash path.

**Done means:** full suite green (124 existing + new), `tsc --noEmit` clean,
`eslint scripts src tests` clean, all floors met, before/after counts recorded in this doc.
**Stop condition:** exotic coverage floor missed ⇒ halt and reassess.

## What slice 2b inherits

An exotic-armor dimension with real tags to rank on; mods constrained per armor slot; plug tags by hash
(name bridge demoted to fallback, hash asymmetry retired); and `championStuns` sitting ready for a
coverage rule that 2b or a later slice can pick up.
