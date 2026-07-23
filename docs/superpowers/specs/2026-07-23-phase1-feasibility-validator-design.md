# D2Synergy — Phase 1: Feasibility Validator (Spec)

**Date:** 2026-07-23
**Status:** Approved (design) — pending implementation plan
**Depends on:** Phase 0 (committed derived dataset + `src/lib/types`, `src/lib/data`)
**Design ref:** `docs/designs/2026-07-22-d2synergy-buildcrafting-design.md` §3a (Validation — hard rules)

---

## 1. Context

Phase 1 delivers the **feasibility validator**: given a (partial) `Build`, it returns
whether the build is legal and, if not, a structured list of what's wrong. It is the
first consumer of the Phase 0 dataset and the hard-rule layer the Phase 2 solver will
call to prune infeasible branches during beam search.

It does **not** complete/optimize builds (that's the Phase 2 solver, design §3b) and it
does **not** score synergy (the `getSynergies`/`scoreSynergy` seam). It only answers:
*is what's specified here legal, and does it meet the tool's baseline build requirements?*

## 2. Scope

**In scope (v1) — four domains of hard rules:** subclass, weapons, armor, artifact.

**Out of scope / deferred:**
- **Champion / anti-barrier coverage** — the data exists only as free text in perk
  descriptions (217 perks), not structured; needs a dedicated extraction pass. Defer.
- **One-exotic-*weapon* rule** — needs a `tier` field on `Weapon` we don't emit, and
  design §3a lists only the exotic-*armor* rule. Defer (documented data gap).
- **Mod energy/slot legality** — deprecated post–Armor 3.0 (energy affinity ignored). Skip.
- **Soft / preference constraints** — ranking, not legality. Belong to Phase 2 scoring
  behind the synergy seam. The `category: "policy"` value is reserved for them; unused in v1.

## 3. Semantics

- **Validates a partial `Build`.** An incomplete build is not automatically invalid.
- **Firing conditions** gate every rule so mid-edit builds aren't nonsensically flagged:
  a rule only fires once its section is *engaged* (see §6). Example: the "2 aspects"
  floor fires only once a subclass is selected.
- **`valid = true` iff there are no `game`-category violations.** (All v1 rules are `game`.)
- **Baseline-vs-illegal honesty:** a few `game` rules are tool *baseline* requirements,
  not literal Destiny-illegal states (aspects = 2, exotic armor = 1, no double-primary).
  They are enforced as hard (`game`) per product decision; the violation `message` states
  the reason so the distinction is visible to users.

## 4. Architecture (Approach A — rule registry + dependency injection)

```
src/lib/validation/
  types.ts       # Violation, ViolationCode, ViolationCategory, ValidationResult, Lookup
  lookup.ts      # createLookup(dataset): Lookup  — hash→entity accessors
  subclass.ts    # subclass rules      (Rule[])
  weapons.ts     # weapon rules        (Rule[])
  armor.ts       # armor rules         (Rule[])
  artifact.ts    # artifact rules      (Rule[])
  index.ts       # validateBuild(build, lookup) + re-exports
```

- Each rule is a small pure function `Rule = (build: Build, lookup: Lookup) => Violation[]`.
- Each domain module exports a `readonly Rule[]`.
- `validateBuild(build, lookup)` concatenates every rule's output and returns
  `{ valid: !violations.some(v => v.category === "game"), violations }`
  (v1: equivalently `violations.length === 0`, since all rules are `game`).
- **DI:** rules depend on the narrow **`Lookup`** interface, never the whole dataset or
  the filesystem. `createLookup(dataset)` builds it (hash→entity maps) for real use;
  unit tests pass a hand-written stub `Lookup` exposing only the entities under test.

## 5. Types

```ts
type ViolationCategory = "game" | "policy"; // policy reserved for Phase 2 soft rules

type ViolationCode =
  // subclass
  | "ASPECT_OVER_LIMIT" | "ASPECT_UNDERFILLED"
  | "FRAGMENT_OVER_CAP" | "FRAGMENT_UNDERFILLED" | "ELEMENT_MISMATCH"
  // weapons
  | "PERK_NOT_IN_POOL" | "PERK_COLUMN_CONFLICT"
  | "WEAPON_SLOT_MISMATCH" | "DUPLICATE_WEAPON_SLOT" | "DOUBLE_PRIMARY_AMMO"
  // armor
  | "MULTIPLE_EXOTIC_ARMOR" | "MISSING_EXOTIC_ARMOR"
  | "ARMOR_CLASS_MISMATCH" | "DUPLICATE_ARMOR_SLOT" | "SET_COUNT_INVALID"
  // artifact
  | "ARTIFACT_TIER_OVER_CAP" | "ARTIFACT_TIER_UNDERFILLED"
  | "ARTIFACT_DUPLICATE_PERK" | "ARTIFACT_PERK_UNKNOWN";

interface ViolationSubject {
  kind: "subclass" | "aspect" | "fragment" | "weapon" | "armor" | "armorSet" | "artifact";
  hash?: Hash;      // the offending entity, when identifiable
  slot?: string;    // e.g. weapon/armor slot, for UI targeting
}

interface Violation {
  code: ViolationCode;
  category: ViolationCategory;   // "game" for all v1 rules
  message: string;               // human-readable "why"
  subject: ViolationSubject;
}

interface ValidationResult {
  valid: boolean;                // no game-category violations
  violations: Violation[];
}

/** Narrow read surface the rules depend on (DI seam). */
interface Lookup {
  weapon(hash: Hash): Weapon | undefined;
  armor(hash: Hash): Armor | undefined;
  armorSet(hash: Hash): ArmorSet | undefined;
  aspect(hash: Hash): Aspect | undefined;
  fragment(hash: Hash): Fragment | undefined;
  subclass(hash: Hash): Subclass | undefined;
  artifact(hash: Hash): Artifact | undefined;
}

type Rule = (build: Build, lookup: Lookup) => Violation[];
```

## 6. Validation rules

`MAX_ASPECTS = 2` (documented game constant). All rules `category: "game"` in v1.

### Subclass (`subclass.ts`) — fires when subclass engaged (element/super set or any aspect/fragment present)
- `ASPECT_OVER_LIMIT` — more than `MAX_ASPECTS` aspects selected (Destiny-illegal).
- `ASPECT_UNDERFILLED` — fewer than `MAX_ASPECTS` aspects (baseline: always run 2).
- `FRAGMENT_OVER_CAP` — fragments selected > Σ `aspect.fragmentSlots` of equipped aspects (illegal). *Fires when aspects set.*
- `FRAGMENT_UNDERFILLED` — fragments < Σ slots (baseline: always max out). *Fires when aspects set.*
- `ELEMENT_MISMATCH` — an equipped aspect/fragment's `element` ≠ subclass element (Prismatic is its own element). *Fires per aspect/fragment present.*

### Weapons (`weapons.ts`) — per-weapon rules fire when that weapon is set
- `PERK_NOT_IN_POOL` — a requested perk (by hash or name) is not in any of the pinned weapon's `perkColumns`.
- `PERK_COLUMN_CONFLICT` — two requested perks fall in the **same** column (can't co-occur).
- `WEAPON_SLOT_MISMATCH` — the pinned weapon's real `slot` ≠ the selection's declared slot.
- `DUPLICATE_WEAPON_SLOT` — two weapons occupy the same slot (also enforces single Heavy/Power).
- `DOUBLE_PRIMARY_AMMO` — both non-Power weapons are Primary ammo (need ≥1 Special; double-Special is allowed). *Fires when both non-Power slots are set. Requires `Weapon.ammoType` (see §7).*

### Armor (`armor.ts`) — fires when armor pieces present; completeness rules at 5 pieces
- `MULTIPLE_EXOTIC_ARMOR` — more than one exotic piece (Destiny-illegal). *Any armor set.*
- `MISSING_EXOTIC_ARMOR` — a complete 5-piece armor set with zero exotics (baseline: exactly 1). *Fires at 5 pieces.*
- `ARMOR_CLASS_MISMATCH` — pieces span classes, or don't match the subclass class when one is set.
- `DUPLICATE_ARMOR_SLOT` — two pieces in the same slot (helmet/arms/chest/legs/class).
- `SET_COUNT_INVALID` — a claimed set bonus lacks enough same-`setHash` pieces, or a set count exceeds 4 alongside an exotic.

### Artifact (`artifact.ts`) — fires when an artifact is pinned
- `ARTIFACT_TIER_OVER_CAP` — perks selected in a tier > that tier's `slots` (2/3/2) (illegal).
- `ARTIFACT_TIER_UNDERFILLED` — perks in a tier < `slots` (baseline: fill all slots).
- `ARTIFACT_DUPLICATE_PERK` — the same perk selected more than once.
- `ARTIFACT_PERK_UNKNOWN` — a selected perk hash isn't in the pinned artifact's tiers.

## 7. Data pre-step — add `ammoType` to `Weapon`

The `DOUBLE_PRIMARY_AMMO` rule needs each weapon's ammo type, which Phase 0 doesn't emit.

- **Type:** add `ammoType: "primary" | "special" | "heavy"` to `Weapon` (`src/lib/types/entities.ts`).
- **Ingestion:** in `transform.ts` map `item.equippingBlock.ammoType`
  (`DestinyAmmunitionType`: 1 Primary, 2 Special, 3 Heavy) to the lowercase union.
- **Re-ingest** (`pnpm ingest --force`) and add a smoke assertion that weapons carry a valid `ammoType`.

This is a small, isolated Phase-0-style addition done first in Phase 1.

## 8. Testing

- **Unit tests per rule** (`tests/validation/<domain>.test.ts`), each with a hand-written
  stub `Lookup` and a minimal `Build` — no dataset, no filesystem. Cover: violation fires
  on the bad case, is silent on the good case, and respects its firing condition (silent on
  the not-yet-engaged partial build).
- **Integration test** using the real dataset via `loadDataset()` + `createLookup`:
  a known-good complete build validates clean; a deliberately broken build produces the
  expected `ViolationCode`s.

## 9. Integration

- New peer module `src/lib/validation/`, alongside `src/lib/data` and `src/lib/synergy`.
  No changes to existing modules except the `ammoType` additions (§7).
- Phase 2's solver will call `validateBuild` to prune infeasible candidates; the `game`
  rules are the pruning set. `policy` (future) will feed ranking, not pruning.

## 10. Open decisions (resolved)

- Domains: subclass + weapons + armor + artifact (champions deferred).
- Result shape: structured `Violation[]` with `code` + `subject` + human `message`.
- Category model: `game` (hard, v1) vs `policy` (soft, reserved for Phase 2).
- Partial-build handling: firing conditions per rule.
- Baseline floors (aspects=2, fragments=max, exotic=1, artifact slots filled, ≥1 special)
  enforced as `game`; ammo revised to "no double-primary" (double-special allowed).
