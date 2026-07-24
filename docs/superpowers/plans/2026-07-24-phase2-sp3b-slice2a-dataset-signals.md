# SP3b slice 2a — Dataset signals (exotic armor, mods, plugs, champions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the derived dataset the four signals SP3b slice 2b needs — exotic-armor intrinsic tags, mod slot restriction, weapon plug tags by hash, and champion-stun coverage — in a single manifest re-ingest.

**Architecture:** Tasks 1-4 change `scripts/ingest/` + the type substrate and are fully testable **offline** against synthetic manifest fixtures (no network, no dependency on committed `data/`). Task 5 fetches the manifest once and *measures* — it sets the mod-identifier mapping and every acceptance floor from evidence, and is where the slice's stop condition is evaluated. Task 6 runs the real ingest and triages season churn. Task 7 locks the measured floors into a contract test.

**Tech Stack:** TypeScript (strict), Node 20+, Vitest, `bungie-api-ts` (ambient const enums — never use as runtime values), pnpm.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-24-phase2-sp3b-slice2a-dataset-signals-design.md`. Read it before Task 1.
- **`bungie-api-ts` const enums have NO runtime value** (ambient, erased by esbuild). Compare numeric literals with a comment, as `transform.ts:287` and `classify.ts:206` already do.
- **Path alias:** `@/*` → `src/`. Scripts under `scripts/` use relative imports (`../../src/lib/types`), never `@/`.
- **Re-ingest command:** `NODE_OPTIONS="--max-old-space-size=2048" pnpm ingest --force`. Requires `BUNGIE_API_KEY` in `.env` (present). **Check `free -h` first** — this box is RAM-constrained.
- **Verification trio** (all three must pass before any task is called done): `npx vitest run`, `npx tsc --noEmit`, `npx eslint scripts src tests`.
- **Baseline at plan start:** 124 tests passing, 28 files, `main` @ `8643e16`.
- **Transform-code commits and regenerated-`data/` commits stay separate** so a bad dataset reverts without losing code.
- **Out of scope** (do not build): any solver dimension for exotics or mods; the champion **coverage rule** or any scoring that reads `championStuns`; synergy weighting changes; `Weapon.tier`; the `AMMO`-record hoist.

---

### Task 1: `championStuns` on the tag substrate

Champion stunning is *coverage*, not a producer→consumer chain — stacking three anti-barrier sources has zero marginal value. So it gets its own field and must never leak into `produces` / `consumes` / `triggers`.

**Files:**
- Modify: `src/lib/types/common.ts` (add `ChampionStun`; add `championStuns?` to `KeywordTags`)
- Modify: `scripts/ingest/keywords.ts:37-120` (add `CHAMPION_VOCABULARY`, emit the field)
- Test: `tests/ingest/keywords-champions.test.ts` (new file; `tests/ingest/` is a new directory)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `type ChampionStun = "barrier" | "overload" | "unstoppable"` exported from `@/lib/types`.
  - `KeywordTags.championStuns?: ChampionStun[]` — **optional, and the tagger omits it entirely when empty**, so entities with no champion phrases emit byte-identical JSON to today.
  - `CHAMPION_VOCABULARY: Record<ChampionStun, string[]>` exported from `scripts/ingest/keywords.ts`.

- [ ] **Step 1: Write the failing tests**

Create `tests/ingest/keywords-champions.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createKeywordTagger } from "../../scripts/ingest/keywords";

const tag = createKeywordTagger();

describe("champion-stun extraction", () => {
  it("tags anti-barrier phrasing as barrier", () => {
    const tags = tag({ text: "Anti-Barrier: Your Sniper Rifles pierce the shields of Barrier Champions." });
    expect(tags.championStuns).toEqual(["barrier"]);
  });

  it("tags overload and unstoppable", () => {
    expect(tag({ text: "Overload Rounds: your weapon overloads targets." }).championStuns)
      .toEqual(["overload"]);
    expect(tag({ text: "Unstoppable Pulse: charged shots stagger unstoppable combatants." }).championStuns)
      .toEqual(["unstoppable"]);
  });

  it("dedupes and preserves vocabulary order across sentences", () => {
    const tags = tag({
      text: "Anti-Barrier: pierce the shields. More anti-barrier text. Unstoppable rounds too.",
    });
    expect(tags.championStuns).toEqual(["barrier", "unstoppable"]);
  });

  it("never leaks champion phrases into produces/consumes/triggers", () => {
    const tags = tag({ text: "Anti-Barrier: pierce the shields of Barrier Champions." });
    expect(tags.produces).toEqual([]);
    expect(tags.consumes).toEqual([]);
    expect(tags.triggers).toEqual([]);
  });

  it("omits the field entirely when no champion phrase is present", () => {
    const tags = tag({ text: "Grants restoration to nearby allies." });
    expect(tags.championStuns).toBeUndefined();
    expect("championStuns" in tags).toBe(false);
  });

  it("still tags ordinary keywords alongside a champion phrase", () => {
    const tags = tag({ text: "Anti-Barrier: pierce the shields. Final blows make targets volatile." });
    expect(tags.championStuns).toEqual(["barrier"]);
    expect(tags.produces).toContain("volatile");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ingest/keywords-champions.test.ts`
Expected: FAIL — `championStuns` is `undefined` on every assertion that expects an array (the property does not exist yet).

- [ ] **Step 3: Add the type**

In `src/lib/types/common.ts`, after the `Keyword` type alias (currently ends line 43), add:

```ts
/**
 * A champion type a source can stun. Modelled separately from the
 * producer/consumer keyword graph because champion stunning is **coverage**, not
 * a chain: a second anti-barrier source adds nothing, so it must never reach the
 * chain scorer (which rewards depth).
 */
export type ChampionStun = "barrier" | "overload" | "unstoppable";
```

Then add the field to `KeywordTags` (after `triggers`, currently line 58):

```ts
  /**
   * Champion types this entity can stun. Optional and omitted when empty, so
   * entities with no champion phrasing emit exactly the bytes they did before
   * this field existed.
   */
  championStuns?: ChampionStun[];
```

`EMPTY_TAGS` needs no change.

- [ ] **Step 4: Add the vocabulary and the tagger pass**

In `scripts/ingest/keywords.ts`, import the type by extending the existing import (line 11):

```ts
import type { ChampionStun, Element, KeywordTags } from "../../src/lib/types";
```

Add the vocabulary after `TRIGGER_VOCABULARY` (currently ends line 75):

```ts
/**
 * Champion-stun vocabulary. Deliberately narrow: these phrases feed
 * `championStuns` ONLY and are never routed through the producer/consumer cue
 * logic. Phrase coverage is measured against the live manifest during ingest
 * (see the slice-2a spec, Execution order step 2) — widen it there, with counts.
 */
export const CHAMPION_VOCABULARY: Record<ChampionStun, string[]> = {
  barrier: ["anti-barrier", "barrier champion", "pierce the shields"],
  overload: ["overload"],
  unstoppable: ["unstoppable"],
};
```

Inside `createKeywordTagger`, add a set alongside the existing three (after line 95):

```ts
    const championStuns = new Set<ChampionStun>();
```

Add the scan inside the sentence loop, after the trigger loop (after line 110):

```ts
      for (const [stun, phrases] of Object.entries(CHAMPION_VOCABULARY) as Array<[ChampionStun, string[]]>) {
        if (phrases.some((phrase) => sentence.includes(phrase))) championStuns.add(stun);
      }
```

And change the return (lines 113-119) to omit the field when empty:

```ts
    return {
      produces: [...produces],
      consumes: [...consumes],
      triggers: [...triggers],
      element,
      ...(championStuns.size > 0 ? { championStuns: [...championStuns] } : {}),
    };
```

Note: iteration order of a `Set` is insertion order, and `Object.entries` preserves the literal key order of `CHAMPION_VOCABULARY`, which is why the dedupe test expects `["barrier", "unstoppable"]`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/ingest/keywords-champions.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Run the full verification trio**

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`
Expected: 124 + 6 = 130 tests pass; no type or lint errors. `KeywordTags` gained an optional field, so no existing construction site breaks.

- [ ] **Step 7: Commit**

```bash
git add src/lib/types/common.ts scripts/ingest/keywords.ts tests/ingest/keywords-champions.test.ts
git commit -m "feat(ingest): extract championStuns as a coverage field on KeywordTags

Champion stunning is coverage, not a producer->consumer chain (a second
anti-barrier source adds nothing), so it gets its own optional field and is
never routed through the produce/consume cue logic. Omitted when empty, so
existing emitted JSON is byte-identical where there is no champion phrasing."
```

---

### Task 2: Mod slot restriction

Today `Mod` carries only `energyCost`, so nothing can say which armor slot a mod belongs to. `plugCategoryIdentifier` is already read at `classify.ts:221` for `plugKind` and then discarded — this task keeps it and derives a slot from it.

**Files:**
- Create: `scripts/ingest/mod-slots.ts`
- Create: `tests/ingest/fixtures.ts` (synthetic manifest-slice builder — Task 3 extends it)
- Create: `tests/ingest/mod-slots.test.ts`
- Modify: `src/lib/types/entities.ts:118-123` (`Mod` gains `plugCategory` + `slotRestriction`)
- Modify: `scripts/ingest/transform.ts:360-385` (`transformMods` emits both)

**Interfaces:**
- Consumes: `ChampionStun` / `KeywordTags.championStuns` from Task 1 (only indirectly, via the real tagger).
- Produces:
  - `type ModSlotRestriction = ArmorSlot | "general" | "artifice"` exported from `@/lib/types`.
  - `modSlotFromPlugCategory(identifier: string): ModSlotRestriction | undefined` exported from `scripts/ingest/mod-slots.ts`.
  - `Mod.plugCategory: string` (always present — `plugKind` only returns `"mod"` for identifiers starting with `enhancements`, so it is never empty) and `Mod.slotRestriction?: ModSlotRestriction`.
  - `tests/ingest/fixtures.ts` exports `H` (a stable hash map) and `makeSlice(overrides?)`, used by Tasks 2 and 3.

**The mapping is provisional and Task 5 reconciles it.** These identifier shapes are the documented/community-known ones; Task 5 measures the real distinct values from the manifest and corrects this table. That is why the unknown case returns `undefined` while `plugCategory` always survives as a raw escape hatch.

- [ ] **Step 1: Write the failing mapping test**

Create `tests/ingest/mod-slots.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { modSlotFromPlugCategory } from "../../scripts/ingest/mod-slots";

describe("modSlotFromPlugCategory", () => {
  it("maps per-slot armor mod identifiers to their ArmorSlot", () => {
    expect(modSlotFromPlugCategory("enhancements.v2_head")).toBe("helmet");
    expect(modSlotFromPlugCategory("enhancements.v2_arms")).toBe("arms");
    expect(modSlotFromPlugCategory("enhancements.v2_chest")).toBe("chest");
    expect(modSlotFromPlugCategory("enhancements.v2_legs")).toBe("legs");
    expect(modSlotFromPlugCategory("enhancements.v2_class_item")).toBe("class");
  });

  it("maps slot-agnostic categories", () => {
    expect(modSlotFromPlugCategory("enhancements.general")).toBe("general");
    expect(modSlotFromPlugCategory("enhancements.artifice")).toBe("artifice");
  });

  it("is case-insensitive", () => {
    expect(modSlotFromPlugCategory("Enhancements.V2_Head")).toBe("helmet");
  });

  it("returns undefined for unknown or activity-scoped identifiers", () => {
    expect(modSlotFromPlugCategory("enhancements.season_outlaw")).toBeUndefined();
    expect(modSlotFromPlugCategory("")).toBeUndefined();
  });

  it("prefers the more specific match when identifiers nest", () => {
    // "class_item" must not be shadowed by a looser "class" probe.
    expect(modSlotFromPlugCategory("enhancements.v2_class_item")).toBe("class");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/ingest/mod-slots.test.ts`
Expected: FAIL — cannot resolve `../../scripts/ingest/mod-slots`.

- [ ] **Step 3: Add the type, then the mapping module**

In `src/lib/types/entities.ts`, replace the `Mod` interface (lines 118-123) with:

```ts
/** Which armor slot a mod can be socketed into (derived from its plug category). */
export type ModSlotRestriction = ArmorSlot | "general" | "artifice";

/** Armor mod — energy cost + keyword effect (untyped post–Armor 3.0). */
export interface Mod extends DerivedEntity {
  kind: "mod";
  energyCost: number;
  /**
   * Raw `plugCategoryIdentifier` (e.g. "enhancements.v2_head"). Kept verbatim as
   * an escape hatch: if the identifier taxonomy shifts, `slotRestriction` goes
   * `undefined` but the cause stays diagnosable without another manifest fetch.
   */
  plugCategory: string;
  /** Derived slot restriction; `undefined` when the identifier is unrecognized. */
  slotRestriction?: ModSlotRestriction;
  tags: KeywordTags;
}
```

`ArmorSlot` is already imported at the top of that file (line 11).

Create `scripts/ingest/mod-slots.ts`:

```ts
/**
 * Mod slot restriction, derived from a plug's `plugCategoryIdentifier`.
 *
 * The manifest expresses "this mod fits helmets" only through the plug category
 * string and the socket-type plumbing; nothing in the emitted dataset carried it
 * before slice 2a. Probes are ordered most-specific-first so "v2_class_item"
 * cannot be shadowed by a looser probe.
 */

import type { ModSlotRestriction } from "../../src/lib/types";

/** Ordered [substring, restriction] probes — first match wins. */
const PROBES: Array<[needle: string, restriction: ModSlotRestriction]> = [
  ["class_item", "class"],
  ["head", "helmet"],
  ["arms", "arms"],
  ["chest", "chest"],
  ["legs", "legs"],
  ["artifice", "artifice"],
  ["general", "general"],
];

/** Map a `plugCategoryIdentifier` to an armor slot restriction, or `undefined`. */
export function modSlotFromPlugCategory(
  identifier: string,
): ModSlotRestriction | undefined {
  const lower = identifier.toLowerCase();
  return PROBES.find(([needle]) => lower.includes(needle))?.[1];
}
```

- [ ] **Step 4: Run the mapping test to verify it passes**

Run: `npx vitest run tests/ingest/mod-slots.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing transform test (with the shared fixture)**

Create `tests/ingest/fixtures.ts`. This synthetic slice is deliberately minimal — just enough for `createClassifier` + `transformAll` to reach armor and mods. Definitions are cast rather than fully typed, matching how existing tests build fixtures (`as unknown as ...`).

```ts
/**
 * Synthetic manifest-slice fixtures for the ingest transform tests.
 *
 * Only the tables `createClassifier` and the armor/mod transforms actually read
 * are populated; everything else is an empty table. Hashes are arbitrary but
 * stable so tests can assert on them.
 */

import type { ManifestSlice } from "../../scripts/ingest/fetchManifest";

/** Stable hashes used across the ingest fixtures. */
export const H = {
  armorCategory: 20,
  helmetBucket: 3448274439,
  intrinsicSocketCategory: 5001,
  armorModsSocketCategory: 5002,
  exoticHelmet: 1001,
  intrinsicPlug: 1002,
  intrinsicSandboxPerk: 1003,
  legendaryHelmet: 1004,
  modItem: 1005,
  modSocketType: 5003,
} as const;

interface SliceParts {
  items?: Record<number, unknown>;
  sandboxPerks?: Record<number, unknown>;
}

/**
 * An exotic helmet whose INTRINSIC TRAITS socket points at `intrinsicPlug`.
 * `perks` is deliberately EMPTY on the armor item — that is the real manifest
 * shape, and the reason `exoticPerkHash` was never populated before slice 2a.
 */
export const exoticHelmetItem = {
  hash: H.exoticHelmet,
  itemType: 2,
  classType: 2, // warlock
  itemCategoryHashes: [H.armorCategory],
  displayProperties: { name: "Test Exotic Helm", description: "Flavor text only." },
  inventory: { bucketTypeHash: H.helmetBucket, tierTypeName: "Exotic" },
  perks: [],
  sockets: {
    socketCategories: [
      { socketCategoryHash: H.intrinsicSocketCategory, socketIndexes: [0] },
      { socketCategoryHash: H.armorModsSocketCategory, socketIndexes: [1] },
    ],
    socketEntries: [
      { singleInitialItemHash: H.intrinsicPlug },
      { socketTypeHash: H.modSocketType },
    ],
  },
};

/**
 * The exotic's intrinsic plug: this is where the real effect text lives.
 * (Named `exoticIntrinsicPlug`, not `intrinsicPlugItem`, to avoid colliding with
 * the transform helper of that name added in Task 3.)
 */
export const exoticIntrinsicPlug = {
  hash: H.intrinsicPlug,
  displayProperties: { name: "Test Intrinsic", description: "" },
  perks: [{ perkHash: H.intrinsicSandboxPerk }],
};

/** A legendary helmet with no intrinsic socket, to prove non-exotics are untouched. */
export const legendaryHelmetItem = {
  hash: H.legendaryHelmet,
  itemType: 2,
  classType: 2,
  itemCategoryHashes: [H.armorCategory],
  displayProperties: { name: "Test Legendary Helm", description: "Grants woven mail." },
  inventory: { bucketTypeHash: H.helmetBucket, tierTypeName: "Legendary" },
  perks: [],
  sockets: { socketCategories: [], socketEntries: [] },
};

/** A helmet-restricted armor mod. */
export const modItem = {
  hash: H.modItem,
  itemType: 19,
  displayProperties: { name: "Test Helmet Mod", description: "Makes targets volatile." },
  plug: { plugCategoryIdentifier: "enhancements.v2_head", energyCost: { energyCost: 3 } },
};

/** Build a manifest slice containing the given items + sandbox perks. */
export function makeSlice(parts: SliceParts = {}): ManifestSlice {
  return {
    DestinyInventoryItemDefinition: parts.items ?? {},
    DestinySandboxPerkDefinition: parts.sandboxPerks ?? {},
    DestinyPlugSetDefinition: {},
    DestinySocketTypeDefinition: {},
    DestinySocketCategoryDefinition: {
      [H.intrinsicSocketCategory]: {
        hash: H.intrinsicSocketCategory,
        displayProperties: { name: "Intrinsic Traits" },
      },
      [H.armorModsSocketCategory]: {
        hash: H.armorModsSocketCategory,
        displayProperties: { name: "Armor Mods" },
      },
    },
    DestinyStatDefinition: {},
    DestinyStatGroupDefinition: {},
    DestinyDamageTypeDefinition: {},
    DestinyInventoryBucketDefinition: {
      [H.helmetBucket]: { hash: H.helmetBucket, displayProperties: { name: "Helmet" } },
    },
    DestinyItemCategoryDefinition: {
      [H.armorCategory]: { hash: H.armorCategory, displayProperties: { name: "Armor" } },
    },
    DestinyEquipableItemSetDefinition: {},
  } as unknown as ManifestSlice;
}
```

Now add the transform test to `tests/ingest/mod-slots.test.ts` (same file, so mod-slot behavior lives in one place). **Put these imports with the existing ones at the top of the file** — appending them beside the new `describe` block would trip `import/first`:

```ts
import { createClassifier } from "../../scripts/ingest/classify";
import { createKeywordTagger } from "../../scripts/ingest/keywords";
import { transformAll } from "../../scripts/ingest/transform";

import { H, makeSlice, modItem } from "./fixtures";

describe("transformMods", () => {
  const run = () => {
    const slice = makeSlice({ items: { [H.modItem]: modItem } });
    return transformAll(slice, createClassifier(slice), createKeywordTagger());
  };

  it("emits the raw plug category and the derived slot restriction", () => {
    const mod = run().mods.find((m) => m.hash === H.modItem);
    expect(mod).toBeDefined();
    expect(mod!.plugCategory).toBe("enhancements.v2_head");
    expect(mod!.slotRestriction).toBe("helmet");
  });

  it("still emits energy cost and tags", () => {
    const mod = run().mods.find((m) => m.hash === H.modItem)!;
    expect(mod.energyCost).toBe(3);
    expect(mod.tags.produces).toContain("volatile");
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run tests/ingest/mod-slots.test.ts`
Expected: FAIL — `mod.plugCategory` is `undefined` (the transform does not emit it yet).

- [ ] **Step 7: Emit both fields from `transformMods`**

In `scripts/ingest/transform.ts`, add the import near the other local imports (after line 40):

```ts
import { modSlotFromPlugCategory } from "./mod-slots";
```

Then in `transformMods` (lines 371-383), replace the loop body's `out.push` with:

```ts
  for (const item of values(items)) {
    if (c.plugKind(item) !== "mod") continue;
    const modName = name(item);
    if (!modName) continue;
    const plugCategory = item.plug?.plugCategoryIdentifier ?? "";
    out.push({
      kind: "mod",
      hash: item.hash,
      name: modName,
      icon: icon(item),
      energyCost: item.plug?.energyCost?.energyCost ?? 0,
      plugCategory,
      slotRestriction: modSlotFromPlugCategory(plugCategory),
      tags: tag({ text: itemText(item, perks) }),
    });
  }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/ingest/mod-slots.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 9: Run the full verification trio**

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`
Expected: all pass. `Mod` gained one required field (`plugCategory`), so if `tsc` flags a test fixture that constructs a `Mod` literal without a cast, add `plugCategory: ""` to it — do not weaken the type.

- [ ] **Step 10: Commit**

```bash
git add src/lib/types/entities.ts scripts/ingest/mod-slots.ts scripts/ingest/transform.ts tests/ingest/
git commit -m "feat(ingest): derive mod slot restriction from plugCategoryIdentifier

Mods carried only energyCost, so nothing could say which armor slot a mod
fits. Emit the raw plugCategory (escape hatch) plus a derived slotRestriction.
The probe table is provisional and gets reconciled against measured manifest
identifiers before the real re-ingest."
```

---

### Task 3: Exotic armor intrinsic extraction

The blocker this whole slice exists for. `transformArmor` reads only `ARMOR MODS` socket categories (`transform.ts:333`), and `exoticPerkHash: item.perks?.[0]?.perkHash` (`transform.ts:353`) is a dead read because armor items' manifest `perks` array is empty — which is why 346/348 exotics have empty tags and 0/348 have an `exoticPerkHash`.

**Files:**
- Modify: `scripts/ingest/transform.ts:311-358` (`transformArmor` + a new `intrinsicPlugItem` helper)
- Modify: `tests/ingest/fixtures.ts` (no change needed if Task 2's fixture landed as written — it already includes the exotic/legendary/intrinsic items)
- Create: `tests/ingest/armor-intrinsic.test.ts`

**Interfaces:**
- Consumes: `H`, `makeSlice`, `exoticHelmetItem`, `intrinsicPlugItem`, `legendaryHelmetItem` from `tests/ingest/fixtures.ts` (Task 2); `createKeywordTagger()` from Task 1.
- Produces: `Armor.tags` populated from intrinsic text for exotics, and `Armor.exoticPerkHash` sourced from the intrinsic plug's first sandbox perk. No type changes — `exoticPerkHash` already exists on `Armor` (`entities.ts:97`).

- [ ] **Step 1: Write the failing tests**

Create `tests/ingest/armor-intrinsic.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createClassifier } from "../../scripts/ingest/classify";
import { createKeywordTagger } from "../../scripts/ingest/keywords";
import { transformAll } from "../../scripts/ingest/transform";

import {
  H,
  exoticHelmetItem,
  exoticIntrinsicPlug,
  legendaryHelmetItem,
  makeSlice,
} from "./fixtures";

/** Run the transform over a slice containing both helmets + one sandbox perk. */
function runWith(perkDescription: string) {
  const slice = makeSlice({
    items: {
      [H.exoticHelmet]: exoticHelmetItem,
      [H.intrinsicPlug]: exoticIntrinsicPlug,
      [H.legendaryHelmet]: legendaryHelmetItem,
    },
    sandboxPerks: {
      [H.intrinsicSandboxPerk]: {
        hash: H.intrinsicSandboxPerk,
        displayProperties: { description: perkDescription },
      },
    },
  });
  return transformAll(slice, createClassifier(slice), createKeywordTagger());
}

describe("exotic armor intrinsic extraction", () => {
  it("tags an exotic from its intrinsic socket's sandbox-perk text", () => {
    const armor = runWith("Grants restoration to nearby allies.").armor;
    const exotic = armor.find((a) => a.hash === H.exoticHelmet);
    expect(exotic).toBeDefined();
    expect(exotic!.tier).toBe("exotic");
    expect(exotic!.tags.produces).toContain("restoration");
  });

  it("populates exoticPerkHash from the intrinsic plug, not the empty item.perks", () => {
    const exotic = runWith("Grants restoration.").armor.find((a) => a.hash === H.exoticHelmet)!;
    expect(exotic.exoticPerkHash).toBe(H.intrinsicSandboxPerk);
  });

  it("unions intrinsic text with the item's own flavor text", () => {
    // Flavor text on the fixture says nothing tag-worthy; the intrinsic says jolt.
    const exotic = runWith("Final blows jolt nearby targets.").armor
      .find((a) => a.hash === H.exoticHelmet)!;
    expect(exotic.tags.produces).toContain("jolt");
  });

  it("leaves non-exotics untouched (tags still come from their own text)", () => {
    const legendary = runWith("Grants restoration.").armor
      .find((a) => a.hash === H.legendaryHelmet)!;
    expect(legendary.tier).toBe("legendary");
    expect(legendary.tags.produces).toContain("woven_mail");
    expect(legendary.tags.produces).not.toContain("restoration");
    expect(legendary.exoticPerkHash).toBeUndefined();
  });

  it("still records the mod socket layout", () => {
    const exotic = runWith("Grants restoration.").armor.find((a) => a.hash === H.exoticHelmet)!;
    expect(exotic.modSocketHashes).toEqual([H.modSocketType]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ingest/armor-intrinsic.test.ts`
Expected: FAIL — the exotic's `tags.produces` is empty and `exoticPerkHash` is `undefined`. (The mod-socket-layout test should already pass; that is intentional, it guards against regressing existing behavior.)

- [ ] **Step 3: Add the intrinsic-plug helper**

In `scripts/ingest/transform.ts`, add after `collectPlugHashes` (which ends line 143):

```ts
/**
 * The plug item socketed in an item's INTRINSIC TRAITS socket, if any.
 *
 * For exotic armor this is where the actual exotic effect text lives: the armor
 * item's own `perks` array is empty in the manifest, so the intrinsic plug (and
 * the sandbox perk it references) is the only route to the effect description.
 * Prefers `singleInitialItemHash`, falling back to the first plug of a plug set
 * for items that express the intrinsic through a set instead.
 */
function intrinsicPlugItem(
  item: DestinyInventoryItemDefinition,
  slice: ManifestSlice,
  classifier: Classifier,
): DestinyInventoryItemDefinition | undefined {
  const sockets = item.sockets;
  if (!sockets) return undefined;
  const items = slice.DestinyInventoryItemDefinition;
  const plugSets = slice.DestinyPlugSetDefinition;

  for (const category of sockets.socketCategories ?? []) {
    if (classifier.socketCategoryName(category.socketCategoryHash) !== "INTRINSIC TRAITS") {
      continue;
    }
    for (const index of category.socketIndexes) {
      const entry = sockets.socketEntries[index];
      if (!entry) continue;
      if (entry.singleInitialItemHash) return items[entry.singleInitialItemHash];
      const plugSetHash = entry.reusablePlugSetHash ?? entry.randomizedPlugSetHash;
      const first = plugSetHash === undefined
        ? undefined
        : plugSets[plugSetHash]?.reusablePlugItems?.[0]?.plugItemHash;
      if (first) return items[first];
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Use it in `transformArmor`**

In `transformArmor`, after the `modSocketHashes` block (which ends line 340) and before `out.push`, add:

```ts
    // The exotic's real effect lives behind its INTRINSIC TRAITS socket; the
    // armor item's own `perks` array is empty in the manifest (which is why the
    // previous `item.perks?.[0]?.perkHash` read yielded nothing for all 348
    // exotics). Tags are the UNION of the item's own text and the intrinsic's.
    const intrinsic = tier === "exotic" ? intrinsicPlugItem(item, slice, c) : undefined;
    const text = [itemText(item, perks), itemText(intrinsic, perks)]
      .filter((part) => part.length > 0)
      .join("\n");
```

Then change the two relevant fields in `out.push` (lines 353-354) to:

```ts
      exoticPerkHash: intrinsic?.perks?.[0]?.perkHash,
      tags: tag({ text }),
```

`itemText` already tolerates `undefined` (line 80), so the non-exotic path needs no guard.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/ingest/armor-intrinsic.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the full verification trio**

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`
Expected: all pass. The `data/`-backed smoke tests still read the OLD committed dataset (unchanged until Task 6), so nothing there should move.

- [ ] **Step 7: Commit**

```bash
git add scripts/ingest/transform.ts tests/ingest/armor-intrinsic.test.ts tests/ingest/fixtures.ts
git commit -m "feat(ingest): read exotic armor intrinsic traits for tags + exoticPerkHash

transformArmor walked only ARMOR MODS socket categories and sourced
exoticPerkHash from item.perks, which is empty for armor in the manifest —
so 346/348 exotics emitted empty tags and 0/348 an exoticPerkHash. Resolve
the INTRINSIC TRAITS plug and union its text with the item's own."
```

---

### Task 4: Weapon plug tags as a side table

Option A, the follow-up slice 1 parked for "the next legitimate re-ingest". Measured: 112,486 plug entries across `weapons.json` but only 1,057 distinct plug hashes — inline `tags` on `WeaponPerk` would add ~7.08MB to a 5.68MB file, while a side table keyed by distinct hash costs ~0.08MB.

**Files:**
- Modify: `scripts/ingest/transform.ts` (`TransformResult`, `transformWeapons` return shape, `transformAll`)
- Modify: `scripts/ingest/paths.ts` (add `PLUG_TAGS_PATH`)
- Modify: `scripts/ingest/emit.ts:18-29,40-48` (entity-key type + write the side table)
- Modify: `src/lib/types/dataset.ts:61-74` (`DerivedDataset.plugTags`)
- Modify: `src/lib/data/index.ts` (`loadPlugTags`, wire into `loadDataset`)
- Modify: `src/lib/validation/types.ts` (`Lookup.plugTags`)
- Modify: `src/lib/validation/lookup.ts:41-53` (implement it)
- Modify: `src/lib/synergy/elements.ts:29-39` (hash-first resolution)
- Modify: `src/lib/solver/beam.ts:118` and `src/lib/solver/candidates.ts:73-74,126-131` (`resolvePlugTags` takes the plug)
- Modify: `src/lib/solver/weapons.ts:82-103` (`deriveWeaponSlotReach` keys by plug hash)
- Modify: `tests/solver/weapons-reach.test.ts:19` (fixture plug hashes currently collide — see Step 7)
- Create: `tests/ingest/plug-tags.test.ts`
- Create: `tests/synergy/elements-plug-tags.test.ts`

**Interfaces:**
- Consumes: `KeywordTags.championStuns` (Task 1) — the "is this tag set empty?" check must include it.
- Produces:
  - `TransformResult.plugTags: Record<Hash, KeywordTags>` and `transformWeapons` returning `{ weapons: Weapon[]; plugTags: Record<Hash, KeywordTags> }`.
  - `data/plug-tags.json`, `PLUG_TAGS_PATH`, `loadPlugTags()`, `DerivedDataset.plugTags: Record<Hash, KeywordTags>`.
  - `Lookup.plugTags(hash: Hash): KeywordTags | undefined`.
  - `SolverEnv.resolvePlugTags: (plug: { hash: Hash; name: string }) => KeywordTags` (**signature change** — was `(name: string) => KeywordTags`).

- [ ] **Step 1: Write the failing ingest test**

Create `tests/ingest/plug-tags.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createClassifier } from "../../scripts/ingest/classify";
import { createKeywordTagger } from "../../scripts/ingest/keywords";
import { transformAll } from "../../scripts/ingest/transform";

import { H, makeSlice } from "./fixtures";

const WEAPON_CATEGORY = 1;
const KINETIC_BUCKET = 1498876634;
const PERK_CATEGORY = 6001;
const PLUG_SET = 7001;
const WEAPON_A = 2001;
const WEAPON_B = 2002;
const TAGGED_PLUG = 3001;
const PLAIN_PLUG = 3002;

/** A slice with two weapons sharing one plug set: one tagged plug, one not. */
function weaponSlice() {
  const slice = makeSlice() as unknown as Record<string, Record<number, unknown>>;
  slice.DestinyItemCategoryDefinition[WEAPON_CATEGORY] = {
    hash: WEAPON_CATEGORY,
    displayProperties: { name: "Weapon" },
  };
  slice.DestinyInventoryBucketDefinition[KINETIC_BUCKET] = {
    hash: KINETIC_BUCKET,
    displayProperties: { name: "Kinetic Weapons" },
  };
  slice.DestinySocketCategoryDefinition[PERK_CATEGORY] = {
    hash: PERK_CATEGORY,
    displayProperties: { name: "Weapon Perks" },
  };
  slice.DestinyPlugSetDefinition[PLUG_SET] = {
    hash: PLUG_SET,
    reusablePlugItems: [
      { plugItemHash: TAGGED_PLUG, currentlyCanRoll: true },
      { plugItemHash: PLAIN_PLUG, currentlyCanRoll: true },
    ],
  };
  slice.DestinyInventoryItemDefinition[TAGGED_PLUG] = {
    hash: TAGGED_PLUG,
    displayProperties: { name: "Voltshot", description: "Reloading jolts targets." },
  };
  slice.DestinyInventoryItemDefinition[PLAIN_PLUG] = {
    hash: PLAIN_PLUG,
    displayProperties: { name: "Smallbore", description: "Increases range." },
  };
  for (const hash of [WEAPON_A, WEAPON_B]) {
    slice.DestinyInventoryItemDefinition[hash] = {
      hash,
      itemType: 3,
      itemCategoryHashes: [WEAPON_CATEGORY],
      displayProperties: { name: `Weapon ${hash}`, description: "" },
      inventory: { bucketTypeHash: KINETIC_BUCKET, tierTypeName: "Legendary" },
      equippingBlock: { ammoType: 1 },
      sockets: {
        socketCategories: [{ socketCategoryHash: PERK_CATEGORY, socketIndexes: [0] }],
        socketEntries: [{ randomizedPlugSetHash: PLUG_SET }],
      },
    };
  }
  return slice as unknown as Parameters<typeof createClassifier>[0];
}

describe("plug-tags side table", () => {
  const run = () => {
    const slice = weaponSlice();
    return transformAll(slice, createClassifier(slice), createKeywordTagger());
  };

  it("tags each distinct plug hash once, keyed by plug hash", () => {
    const { plugTags } = run();
    expect(plugTags[TAGGED_PLUG]?.produces).toContain("jolt");
  });

  it("omits plugs whose text yields no tags", () => {
    expect(run().plugTags[PLAIN_PLUG]).toBeUndefined();
  });

  it("does not inline tags onto WeaponPerk entries", () => {
    const weapon = run().weapons.find((w) => w.hash === WEAPON_A)!;
    const plug = weapon.perkColumns[0].plugs.find((p) => p.hash === TAGGED_PLUG)!;
    expect(Object.keys(plug).sort()).toEqual(["hash", "name"]);
  });

  it("dedupes across weapons sharing a plug", () => {
    const { plugTags, weapons } = run();
    expect(weapons).toHaveLength(2);
    expect(Object.keys(plugTags)).toEqual([String(TAGGED_PLUG)]);
  });

  it("keeps the armor fixture path working (transformAll still returns armor)", () => {
    expect(run().armor).toEqual([]);
    expect(H.armorCategory).toBe(20); // fixture sanity
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/ingest/plug-tags.test.ts`
Expected: FAIL — `plugTags` does not exist on the transform result.

- [ ] **Step 3: Produce the side table in the transform**

In `scripts/ingest/transform.ts`:

Add `KeywordTags` to the type import from `../../src/lib/types` (the import block at lines 20-37).

Add `plugTags` to `TransformResult` (after `stats`, line 53):

```ts
  /**
   * Weapon plug hash → its keyword tags, for plugs that have any. A SIDE TABLE
   * rather than a `tags` field on `WeaponPerk`: there are ~112k plug entries but
   * only ~1k distinct plug hashes, so inlining costs ~7MB against ~0.08MB here.
   */
  plugTags: Record<Hash, KeywordTags>;
```

Change `transformWeapons`'s return type (line 241) from `Weapon[]` to:

```ts
): { weapons: Weapon[]; plugTags: Record<Hash, KeywordTags> } {
```

Inside it, declare a collector next to `out` (line 248):

```ts
  const plugItems = new Map<Hash, DestinyInventoryItemDefinition | undefined>();
```

In the plug loop, record the plug item right after `seen.add(plug.plugItemHash)` (line 280):

```ts
          plugItems.set(plug.plugItemHash, items[plug.plugItemHash]);
```

Replace the closing `return out;` (line 308) with:

```ts
  const plugTags: Record<Hash, KeywordTags> = {};
  for (const [hash, plugItem] of plugItems) {
    const tags = tag({ text: itemText(plugItem, perks) });
    const hasAny =
      tags.produces.length > 0 ||
      tags.consumes.length > 0 ||
      tags.triggers.length > 0 ||
      (tags.championStuns?.length ?? 0) > 0;
    if (hasAny) plugTags[hash] = tags;
  }
  return { weapons: out, plugTags };
}
```

Update `transformAll` (lines 541-552):

```ts
  const { weapons, plugTags } = transformWeapons(slice, classifier, tag);
  return {
    subclasses: transformSubclasses(slice, classifier),
    aspects: transformAspects(slice, classifier, tag),
    fragments: transformFragments(slice, classifier, tag),
    weapons,
    armor: transformArmor(slice, classifier, tag),
    armorSets: transformArmorSets(slice, tag),
    mods: transformMods(slice, classifier, tag),
    artifacts: transformArtifacts(slice, classifier, tag),
    perks: transformPerks(slice, tag),
    stats: transformStats(slice),
    plugTags,
  };
```

- [ ] **Step 4: Run the ingest test to verify it passes**

Run: `npx vitest run tests/ingest/plug-tags.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Emit and load the file**

In `scripts/ingest/paths.ts`, after `INDEXES_PATH`:

```ts
export const PLUG_TAGS_PATH = path.join(DATA_DIR, "plug-tags.json");
```

In `scripts/ingest/emit.ts`, `plugTags` is a `Record`, not an array, so it must be excluded from the array-driven `ENTITY_FILES` loop. Change the declaration (lines 17-18) to:

```ts
/** Keys of `TransformResult` that serialize as plain entity arrays. */
type EntityKey = Exclude<keyof TransformResult, "plugTags">;

/** Output filename → the `TransformResult` array it serializes. */
const ENTITY_FILES: Array<[file: string, key: EntityKey]> = [
```

Import the new path (line 14): `import { DATA_DIR, INDEXES_PATH, META_PATH, PLUG_TAGS_PATH } from "./paths";`

And after the `INDEXES_PATH` write (line 50):

```ts
  await writeFile(PLUG_TAGS_PATH, JSON.stringify(options.result.plugTags));
  counts.plugTags = Object.keys(options.result.plugTags).length;
```

(Place it before the `meta` object is built so the count is included.)

In `src/lib/types/dataset.ts`, add to `DerivedDataset` (after `stats`, line 72):

```ts
  /** Weapon plug hash → keyword tags (side table; see `TransformResult`). */
  plugTags: Record<Hash, KeywordTags>;
```

and extend its import from `./common` (line 6-13) with `KeywordTags`.

In `src/lib/data/index.ts`, add the loader beside the others:

```ts
export const loadPlugTags = () =>
  loadJson<Record<Hash, KeywordTags>>("plug-tags.json");
```

adding `Hash` and `KeywordTags` to the type import, then add `loadPlugTags()` to the `Promise.all` array and `plugTags` to both the destructuring and the returned object — keeping array order and destructuring order aligned.

- [ ] **Step 6: Write the failing synergy/lookup test**

Create `tests/synergy/elements-plug-tags.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createLookup } from "@/lib/validation";
import type { Build, DerivedDataset } from "@/lib/types";

import { collectBuildElements } from "@/lib/synergy/elements";

const EMPTY_INDEXES = {
  keyword: { producers: {}, consumers: {} },
  perkToWeapons: {}, elementToItems: {}, setToPieces: {},
  exoticToClassSlot: {}, slotToWeapons: {},
};

function datasetWith(partial: Partial<DerivedDataset>): DerivedDataset {
  return {
    meta: { ingestedAt: "", manifestVersion: "", counts: {} },
    subclasses: [], aspects: [], fragments: [], weapons: [], armor: [],
    armorSets: [], mods: [], artifacts: [], perks: [], stats: [], plugTags: {},
    indexes: EMPTY_INDEXES as DerivedDataset["indexes"], ...partial,
  } as DerivedDataset;
}

const buildWithPlug = (plugHash: number, plugName: string) => ({
  subclass: { element: "arc", aspectHashes: [], fragmentHashes: [] },
  weapons: [{ slot: "kinetic", itemHash: 500,
    perkConstraints: [{ perkHash: plugHash, perkName: plugName, column: 0 }] }],
  armor: { modHashes: [] },
  artifact: { selectedPerkHashes: [] },
}) as unknown as Build;

describe("collectBuildElements plug-tag resolution", () => {
  it("resolves a plug's tags by HASH from the side table", () => {
    const lookup = createLookup(datasetWith({
      plugTags: { 900: { produces: ["jolt"], consumes: [], triggers: [] } },
    }));
    const els = collectBuildElements(buildWithPlug(900, "Voltshot"), lookup);
    const el = els.find((e) => e.hash === 900);
    expect(el?.tags.produces).toEqual(["jolt"]);
  });

  it("prefers the side table over the name bridge when both could resolve", () => {
    const lookup = createLookup(datasetWith({
      plugTags: { 900: { produces: ["jolt"], consumes: [], triggers: [] } },
      perks: [{ kind: "perk", hash: 42, name: "Voltshot", icon: "", description: "",
        tags: { produces: ["scorch"], consumes: [], triggers: [] } }],
    }));
    const els = collectBuildElements(buildWithPlug(900, "Voltshot"), lookup);
    expect(els.flatMap((e) => e.tags.produces)).toContain("jolt");
    expect(els.flatMap((e) => e.tags.produces)).not.toContain("scorch");
  });

  it("falls back to the name bridge when the plug is absent from the side table", () => {
    const lookup = createLookup(datasetWith({
      perks: [{ kind: "perk", hash: 42, name: "Voltshot", icon: "", description: "",
        tags: { produces: ["jolt"], consumes: [], triggers: [] } }],
    }));
    const els = collectBuildElements(buildWithPlug(900, "Voltshot"), lookup);
    expect(els.find((e) => e.hash === 42)?.tags.produces).toEqual(["jolt"]);
  });
});
```

Run: `npx vitest run tests/synergy/elements-plug-tags.test.ts`
Expected: FAIL — `lookup.plugTags` is not a function.

- [ ] **Step 7: Wire the lookup, the synergy resolution, and the solver**

`src/lib/validation/types.ts` — add to the `Lookup` interface, after `perkByName`:

```ts
  /**
   * Keyword tags for a weapon plug, by PLUG hash (the ingest side table). Plug
   * hashes are a different namespace from `perks.json`, so this — not `perk()` —
   * is the primary route to a roll's synergy.
   */
  plugTags(hash: Hash): KeywordTags | undefined;
```

adding `KeywordTags` to that file's type import.

`src/lib/validation/lookup.ts` — add to the returned object (after `perkByName`, line 50):

```ts
    plugTags: (hash) => dataset.plugTags?.[hash],
```

`src/lib/synergy/elements.ts` — replace the `perkConstraints` loop (lines 30-38) with:

```ts
    for (const c of w.perkConstraints) {
      // Resolve a plug's tags by HASH from the ingest side table first; then as a
      // sandbox perk by hash; then via the legacy plug-NAME bridge (kept as a
      // fallback for datasets emitted before the side table existed).
      const sideTags = c.perkHash !== undefined ? lookup.plugTags(c.perkHash) : undefined;
      if (sideTags && c.perkHash !== undefined) {
        add(c.perkHash, `perk:${c.perkName ?? c.perkHash}`, sideTags);
        continue;
      }
      const p =
        (c.perkHash !== undefined ? lookup.perk(c.perkHash) : undefined) ??
        (c.perkName !== undefined ? lookup.perkByName(c.perkName) : undefined);
      if (p) add(p.hash, `perk:${p.name}`, p.tags);
    }
```

`src/lib/solver/beam.ts` — change `resolvePlugTags` (line 118) to take the plug so it can try hash then name:

```ts
  const resolvePlugTags = (plug: { hash: Hash; name: string }) =>
    ctx.lookup.plugTags(plug.hash) ?? ctx.lookup.perkByName(plug.name)?.tags ?? EMPTY_TAGS;
```

and update the `SolverEnv` field's type (line 50):

```ts
  /** Plug → tags resolver: side table by hash, then the name bridge, then empty. */
  resolvePlugTags: (plug: { hash: Hash; name: string }) => KeywordTags;
```

`src/lib/solver/candidates.ts` — update `CandidateEnv` (lines 73-74) to the same signature, change the call site (line 131) to `tags: env.resolvePlugTags(plug)`, and **replace** the now-obsolete asymmetry comment (lines 126-129) with:

```ts
        // Candidate/element hash is the plugItemHash, and the side table is keyed by
        // the same hash — move identity and synergy identity now coincide (slice 2a).
```

`src/lib/solver/weapons.ts` — `deriveWeaponSlotReach` (lines 93-101) keys reach by plug hash so it shares the candidates' identity space:

```ts
  for (const { weapon, openColumns } of pool) {
    add(weapon.hash, `weapon:${weapon.name}`, weapon.tags);
    for (const col of openColumns) {
      for (const plug of col.plugs) {
        const tags = ctx.lookup.plugTags(plug.hash) ?? ctx.lookup.perkByName(plug.name)?.tags;
        if (tags) add(plug.hash, `perk:${plug.name}`, tags);
      }
    }
  }
```

Update that function's docstring (lines 76-81) to say tags resolve from the side table by plug hash, falling back to the name bridge, and that reach is keyed by **plug** hash.

**Required fixture fix:** `tests/solver/weapons-reach.test.ts:19` gives every weapon's plugs hashes `1000 + i`, so weapon A's first plug and weapon B's first plug **share hash 1000**. Under hash-keyed dedup the second one would silently drop and the test's `scorch` expectation would fail — that is a fixture collision, not a code defect. Change that line to make plug hashes unique per weapon:

```ts
    perkColumns: [{ socketIndex: 0, plugs: plugNames.map((n, i) => ({ hash: hash * 100 + i, name: n })) }],
```

- [ ] **Step 8: Run the new tests, then the full suite**

Run: `npx vitest run tests/synergy/elements-plug-tags.test.ts tests/ingest/plug-tags.test.ts`
Expected: PASS (8 tests).

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`
Expected: all pass. Two things to expect and handle:
1. `tsc` may flag test fixtures that build a `DerivedDataset` **without** an `as`/`as unknown as` cast, now that `plugTags` is required. Add `plugTags: {}` to each — do not make the field optional.
2. `data/plug-tags.json` does not exist yet, so `loadDataset()` will reject. The real-data suites guard on `existsSync(data/dataset-meta.json)` (`dataset.smoke.test.ts:18`, `integration-weapons.test.ts:13`) and will therefore still RUN and now FAIL. **Create a placeholder so the suite stays green until Task 6 regenerates it:**

```bash
echo '{}' > data/plug-tags.json
```

Commit that placeholder with this task and note in the commit message that Task 6 replaces it with real content. An empty side table is semantically correct: no plug has tags yet, and the name-bridge fallback keeps behavior identical to today.

- [ ] **Step 9: Commit**

```bash
git add scripts/ingest/ src/lib/types/dataset.ts src/lib/data/index.ts src/lib/validation/ \
        src/lib/synergy/elements.ts src/lib/solver/ tests/ data/plug-tags.json
git commit -m "feat(ingest): emit weapon plug tags as a hash-keyed side table

Option A, parked by slice 1 for the next legitimate re-ingest. 112,486 plug
entries but only 1,057 distinct hashes, so inline tags on WeaponPerk would
cost ~7.08MB vs ~0.08MB for data/plug-tags.json. Plug tags now resolve by
hash (name bridge demoted to fallback), so move identity and synergy identity
coincide and the candidates.ts asymmetry note is retired. data/plug-tags.json
ships as an empty placeholder here; the re-ingest task fills it."
```

---

### Task 5: Inspection run — measure, reconcile, set the floors

**This task decides whether the slice continues.** Everything before it was written against documented shapes; this fetches the manifest once and replaces every assumption with a count. No `data/` files are regenerated here.

**Files:**
- Create: `<scratchpad>/inspect-manifest.ts` (scratchpad only — NOT committed)
- Create: `<scratchpad>/inspection-report.md` (the raw measurements)
- Modify: `scripts/ingest/mod-slots.ts` (reconcile `PROBES` against measured identifiers, if needed)
- Modify: `scripts/ingest/keywords.ts` (widen `CHAMPION_VOCABULARY`, if measurement shows misses)
- Modify: `tests/ingest/mod-slots.test.ts` and/or `tests/ingest/keywords-champions.test.ts` (real identifiers/phrases as cases)
- Modify: `docs/superpowers/specs/2026-07-24-phase2-sp3b-slice2a-dataset-signals-design.md` (record the measured floors)

**Interfaces:**
- Consumes: `fetchManifest({ apiKey, force })` → `{ version, changed, slice }` from `scripts/ingest/fetchManifest.ts`; `createClassifier`, `createKeywordTagger`, `transformAll` from Tasks 1-4; `modSlotFromPlugCategory` (Task 2).
- Produces: measured floor values recorded in the spec, consumed by Task 7's contract test; a reconciled `PROBES` table and champion vocabulary.

- [ ] **Step 1: Write the inspection script**

Write to the session scratchpad directory (not the repo). It reuses the real pipeline so what it measures is what Task 6 will emit.

```ts
/**
 * One-shot manifest inspection for SP3b slice 2a. Fetches the slice ONCE and
 * reports the facts that the transform mapping and the acceptance floors depend
 * on. Writes nothing to data/.
 */
import { writeFile } from "node:fs/promises";

import { createClassifier } from "../../scripts/ingest/classify";
import { createKeywordTagger } from "../../scripts/ingest/keywords";
import { fetchManifest } from "../../scripts/ingest/fetchManifest";
import { modSlotFromPlugCategory } from "../../scripts/ingest/mod-slots";
import { transformAll } from "../../scripts/ingest/transform";

const apiKey = process.env.BUNGIE_API_KEY;
if (!apiKey) throw new Error("BUNGIE_API_KEY missing");

const { version, slice } = await fetchManifest({ apiKey, force: true });
if (!slice) throw new Error("no slice returned");

const result = transformAll(slice, createClassifier(slice), createKeywordTagger());
const tagged = (t: { produces: string[]; consumes: string[]; triggers: string[] }) =>
  t.produces.length > 0 || t.consumes.length > 0 || t.triggers.length > 0;

const exotics = result.armor.filter((a) => a.tier === "exotic");
const withPerk = exotics.filter((a) => a.exoticPerkHash !== undefined);
const taggedExotics = exotics.filter((a) => tagged(a.tags));

const identifiers = new Map<string, number>();
for (const m of result.mods) {
  identifiers.set(m.plugCategory, (identifiers.get(m.plugCategory) ?? 0) + 1);
}
const unmapped = [...identifiers.keys()].filter((id) => !modSlotFromPlugCategory(id));

const champions = [
  ...result.mods.map((m) => m.tags),
  ...result.artifacts.flatMap((a) => a.tiers.flatMap((t) => t.perks.map((p) => p.tags))),
  ...result.perks.map((p) => p.tags),
].filter((t) => (t.championStuns?.length ?? 0) > 0);

const lines = [
  `# Slice 2a inspection — manifest ${version}`,
  ``,
  `## Exotic armor`,
  `- exotics: ${exotics.length}`,
  `- with exoticPerkHash: ${withPerk.length} (${((withPerk.length / exotics.length) * 100).toFixed(1)}%)`,
  `- with non-empty tags: ${taggedExotics.length} (${((taggedExotics.length / exotics.length) * 100).toFixed(1)}%)`,
  `- sample tagged: ${taggedExotics.slice(0, 15).map((a) => `${a.name}[${a.tags.produces.join("/")}]`).join(", ")}`,
  `- sample UNtagged: ${exotics.filter((a) => !tagged(a.tags)).slice(0, 15).map((a) => a.name).join(", ")}`,
  ``,
  `## Mods`,
  `- mods: ${result.mods.length}`,
  `- with slotRestriction: ${result.mods.filter((m) => m.slotRestriction).length}`,
  `- distinct plugCategory values (count):`,
  ...[...identifiers.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `  - ${id}: ${n}`),
  `- UNMAPPED identifiers: ${unmapped.join(", ") || "(none)"}`,
  ``,
  `## Plug tags`,
  `- distinct tagged plugs: ${Object.keys(result.plugTags).length}`,
  ``,
  `## Champions`,
  `- entities with championStuns: ${champions.length}`,
  `- by type: ${JSON.stringify(champions.reduce<Record<string, number>>((acc, t) => {
      for (const s of t.championStuns ?? []) acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {}))}`,
  ``,
  `## Structure watchlist`,
  `- artifacts: ${result.artifacts.length}`,
  `- tier slot shapes: ${JSON.stringify(result.artifacts.map((a) => a.tiers.map((t) => t.slots)))}`,
];

await writeFile("inspection-report.md", `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
```

- [ ] **Step 2: Check memory headroom, then run it once**

```bash
free -h
NODE_OPTIONS="--max-old-space-size=2048" npx tsx <scratchpad>/inspect-manifest.ts
```

Expected: `inspection-report.md` written, and the same report on stdout. If the process is OOM-killed (exit 137), re-run with `--max-old-space-size=3072`; do not add a second fetch in the same process.

- [ ] **Step 3: Evaluate the stop condition**

Read the exotic tag-coverage percentage.

- **If exotic tag coverage is materially better than today's 0.6% (2/348) — report it and continue.** Record the measured percentage; Task 7's floor is set slightly below it (round down to a stable number, e.g. measured 71% → floor 65%) so ordinary season drift doesn't fail the suite.
- **If coverage is still near zero, STOP.** Do not run Task 6. Report the numbers and the sample untagged exotic names, and hand back for reassessment — the spec's stop condition. Likely cause worth reporting: intrinsic plugs reached via a plug set rather than `singleInitialItemHash`, or effect text living in the plug's `displayProperties.description` while its `perks` array is empty (check a sample by hand before concluding).

- [ ] **Step 4: Reconcile the mod mapping**

If the report lists UNMAPPED identifiers that clearly belong to a slot (or if a mapped identifier is wrong), update `PROBES` in `scripts/ingest/mod-slots.ts` and add the **real** identifier strings as cases in `tests/ingest/mod-slots.test.ts`. Activity/seasonal identifiers legitimately stay unmapped — that is what `undefined` is for; note them in the report rather than forcing a mapping.

- [ ] **Step 5: Reconcile the champion vocabulary**

If the champion counts look implausibly low, or the `overload` count looks inflated by non-champion uses of the word, adjust `CHAMPION_VOCABULARY` and add the observed phrasing to `tests/ingest/keywords-champions.test.ts`. Keep phrases narrow; prefer a miss over a false positive, since a false positive silently pollutes coverage data.

- [ ] **Step 6: Record the floors in the spec**

In the spec's Test plan section, replace each "≥ floor" with the concrete number chosen in Steps 3-5, and add a short "Measured (manifest `<version>`)" block with the report's headline counts: exotic coverage, mods with `slotRestriction`, distinct tagged plugs, champion entities, artifact count and tier shapes.

- [ ] **Step 7: Run the verification trio and commit**

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`
Expected: all pass (the reconciled mapping/vocabulary tests included).

```bash
git add scripts/ingest/mod-slots.ts scripts/ingest/keywords.ts tests/ingest/ \
        docs/superpowers/specs/2026-07-24-phase2-sp3b-slice2a-dataset-signals-design.md
git commit -m "chore(ingest): reconcile mod/champion mappings against the live manifest

Measured from a single inspection fetch (manifest <version>): exotic tag
coverage, mod plugCategory taxonomy, distinct tagged plugs, champion counts.
Acceptance floors recorded in the spec; the inspection script and report stay
in the scratchpad (not committed)."
```

---

### Task 6: Re-ingest and churn triage

**Files:**
- Modify: `data/*.json` (all regenerated, including the real `data/plug-tags.json`)
- Modify: whichever real-data tests legitimately need re-baselining (see Step 3)

**Interfaces:**
- Consumes: the whole transform from Tasks 1-5.
- Produces: a regenerated dataset, and a before/after count table recorded in the spec.

- [ ] **Step 1: Record the "before" counts**

```bash
cat data/dataset-meta.json
git rev-parse --short HEAD
```

Keep this output — it goes in the spec and the commit message.

- [ ] **Step 2: Run the real ingest**

```bash
free -h
NODE_OPTIONS="--max-old-space-size=2048" pnpm ingest --force
git status --short data/
```

Expected: the ingest prints per-entity counts including `plugTags`, and `data/` shows modified files plus a now-non-empty `plug-tags.json`. On exit 137 (OOM), retry with `--max-old-space-size=3072`.

- [ ] **Step 3: Triage the suite**

```bash
npx vitest run
```

Every failure is one of exactly two things — classify each explicitly and say which in the commit message:

1. **Legitimate season churn** → re-baseline the assertion, recording old → new in the spec. Watchlist:
   - `tests/solver/integration-weapons.test.ts:93` — the 25,000 bound-call ceiling (was measured at 11,190).
   - `tests/synergy/weapon-curated-resolution.test.ts` — the five curated perk names; a renamed or retired perk is churn, a *missing tag* on a still-present perk is a regression.
   - `tests/dataset.smoke.test.ts` — artifact tier assertions if a new season artifact appeared (7 → 8 items, or a different tier shape). **A changed tier shape is NOT routine** — SP2's capacity model assumes 3 tiers with slots 2/3/2; if that moved, stop and report rather than re-baselining, because the oracle's Hall-condition proof is scoped to the nested 2/3/2 structure.
2. **Genuine regression** → fix the code, not the test.

- [ ] **Step 4: Verify the new signals actually landed**

```bash
node -e '
const armor=require("./data/armor.json"), mods=require("./data/mods.json"), pt=require("./data/plug-tags.json");
const ex=armor.filter(a=>a.tier==="exotic");
const t=x=>x.tags.produces.length||x.tags.consumes.length||x.tags.triggers.length;
console.log("exotics:",ex.length,"tagged:",ex.filter(t).length,"withPerkHash:",ex.filter(a=>a.exoticPerkHash!==undefined).length);
console.log("mods:",mods.length,"withSlot:",mods.filter(m=>m.slotRestriction).length);
console.log("tagged plugs:",Object.keys(pt).length);
'
```

Expected: numbers matching Task 5's report (small drift is fine; a large gap means the transform path differs from what the inspection measured — investigate before committing).

- [ ] **Step 5: Commit code fixes and data separately**

```bash
# 1) any test re-baselines / regression fixes
git add tests src scripts
git commit -m "test: re-baseline real-data assertions after slice-2a re-ingest

<list each changed assertion: old -> new, and why it is churn not regression>"

# 2) the dataset itself, alone, so it can be reverted independently
git add data/
git commit -m "data: re-ingest manifest <version> with slice-2a signals

Before: <counts from Step 1>
After:  <counts from the ingest output>
Adds exotic armor intrinsic tags + exoticPerkHash, mod plugCategory/
slotRestriction, data/plug-tags.json, and championStuns."
```

- [ ] **Step 6: Confirm the trio on the regenerated data**

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`
Expected: all green. Report the final test count.

---

### Task 7: Contract tests and curated spot-checks

Locks the measured floors in so a future re-ingest that silently drops a signal fails loudly — the failure mode that produced this slice's blocker.

**Files:**
- Create: `tests/dataset.contract.test.ts`
- Modify: `tests/synergy/weapon-curated-resolution.test.ts` (retarget from the name path to the plug-hash path)

**Interfaces:**
- Consumes: `loadDataset()` from `@/lib/data`; `createLookup` from `@/lib/validation`; the floors recorded in the spec by Task 5.
- Produces: nothing downstream — this is the acceptance gate.

- [ ] **Step 1: Write the contract test**

Create `tests/dataset.contract.test.ts`. Replace every `FLOOR_*` value with the number recorded in the spec by Task 5 — these are placeholders **only** until that substitution, which happens as part of this step:

```ts
/**
 * Data-contract assertions for the slice-2a signals.
 *
 * Unlike the smoke tests (which assert "> 0"), these hold measured FLOORS: if a
 * future re-ingest silently stops extracting exotic intrinsics, mod slots, plug
 * tags, or champion coverage, this fails loudly. Floors sit below the measured
 * values so ordinary season drift does not trip them; a floor breach means the
 * extraction broke, not that the game changed.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import type { DerivedDataset, KeywordTags } from "@/lib/types";

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));

// Floors recorded in docs/superpowers/specs/2026-07-24-phase2-sp3b-slice2a-dataset-signals-design.md
const FLOOR_EXOTIC_TAG_RATIO = 0; // ← set from the spec's measured value
const FLOOR_EXOTIC_PERK_HASH_RATIO = 0; // ←
const FLOOR_MODS_WITH_SLOT = 0; // ←
const FLOOR_TAGGED_PLUGS = 0; // ←
const FLOOR_CHAMPION_ENTITIES = 0; // ←

const isTagged = (t: KeywordTags) =>
  t.produces.length > 0 || t.consumes.length > 0 || t.triggers.length > 0;

describe.runIf(hasDataset)("dataset contract — slice 2a signals", () => {
  let ds: DerivedDataset;

  beforeAll(async () => {
    ds = await loadDataset();
  });

  // Guard against shipping this file with the floors left unsubstituted: a floor of
  // 0 would make every assertion below vacuous, which is exactly the silent-pass
  // failure mode this file exists to prevent.
  it("has real floors substituted from the spec's measurements", () => {
    expect(FLOOR_EXOTIC_TAG_RATIO).toBeGreaterThan(0);
    expect(FLOOR_EXOTIC_PERK_HASH_RATIO).toBeGreaterThan(0);
    expect(FLOOR_MODS_WITH_SLOT).toBeGreaterThan(0);
    expect(FLOOR_TAGGED_PLUGS).toBeGreaterThan(0);
    expect(FLOOR_CHAMPION_ENTITIES).toBeGreaterThan(0);
  });

  it("tags a floor share of exotic armor from its intrinsic", () => {
    const exotics = ds.armor.filter((a) => a.tier === "exotic");
    expect(exotics.length).toBeGreaterThan(0);
    const ratio = exotics.filter((a) => isTagged(a.tags)).length / exotics.length;
    expect(ratio).toBeGreaterThanOrEqual(FLOOR_EXOTIC_TAG_RATIO);
  });

  it("populates exoticPerkHash for a floor share of exotics", () => {
    const exotics = ds.armor.filter((a) => a.tier === "exotic");
    const ratio = exotics.filter((a) => a.exoticPerkHash !== undefined).length / exotics.length;
    expect(ratio).toBeGreaterThanOrEqual(FLOOR_EXOTIC_PERK_HASH_RATIO);
  });

  it("gives every mod a raw plug category and a floor number a slot restriction", () => {
    expect(ds.mods.every((m) => m.plugCategory.length > 0)).toBe(true);
    expect(ds.mods.filter((m) => m.slotRestriction !== undefined).length)
      .toBeGreaterThanOrEqual(FLOOR_MODS_WITH_SLOT);
  });

  it("emits a non-trivial plug-tag side table with no empty entries", () => {
    const entries = Object.entries(ds.plugTags);
    expect(entries.length).toBeGreaterThanOrEqual(FLOOR_TAGGED_PLUGS);
    // An empty tag set must never be stored — that is the whole point of the side table.
    expect(entries.filter(([, t]) => !isTagged(t) && !(t.championStuns?.length))).toEqual([]);
  });

  it("extracts champion coverage across mods, artifact perks, and sandbox perks", () => {
    const all: KeywordTags[] = [
      ...ds.mods.map((m) => m.tags),
      ...ds.artifacts.flatMap((a) => a.tiers.flatMap((t) => t.perks.map((p) => p.tags))),
      ...ds.perks.map((p) => p.tags),
    ];
    expect(all.filter((t) => (t.championStuns?.length ?? 0) > 0).length)
      .toBeGreaterThanOrEqual(FLOOR_CHAMPION_ENTITIES);
  });

  it("never routes champion phrases into the chain graph", () => {
    const champion = new Set(["barrier", "overload", "unstoppable"]);
    const leaked = ds.mods.filter((m) =>
      m.tags.produces.some((k) => champion.has(k)) ||
      m.tags.consumes.some((k) => champion.has(k)));
    expect(leaked.map((m) => m.name)).toEqual([]);
  });

  it("holds the artifact structure SP2's capacity oracle assumes", () => {
    for (const artifact of ds.artifacts) {
      expect(artifact.tiers, artifact.name).toHaveLength(3);
      expect(artifact.tiers.reduce((sum, t) => sum + t.slots, 0), artifact.name).toBe(7);
    }
  });
});
```

- [ ] **Step 2: Add the curated spot-checks**

Append to the same file — pick the exotic names from Task 5's "sample tagged" list so they are known-present, and one real anti-barrier artifact perk name:

```ts
describe.runIf(hasDataset)("dataset contract — curated spot-checks", () => {
  let ds: DerivedDataset;

  beforeAll(async () => {
    ds = await loadDataset();
  });

  // [exotic armor name, bucket, keyword] — chosen from the Task 5 measurement.
  // REQUIRED: at least 4 entries spanning different elements, so a single retired
  // exotic cannot take the whole gate down and one element's extraction breaking
  // is still caught. Pick them from the report's "sample tagged" list.
  const CURATED_EXOTICS: Array<[string, "produces" | "consumes" | "triggers", string]> = [
    ["Swarmers", "produces", "tangle"],
    // ← add at least three more, each a different element
  ];

  for (const [name, bucket, keyword] of CURATED_EXOTICS) {
    it(`${name} resolves to ${bucket}:${keyword}`, () => {
      const piece = ds.armor.find((a) => a.name === name && a.tier === "exotic");
      expect(piece, `${name} must be present`).toBeDefined();
      expect(piece!.tags[bucket]).toContain(keyword);
    });
  }

  it("an anti-barrier artifact perk carries championStuns barrier", () => {
    const perks = ds.artifacts.flatMap((a) => a.tiers.flatMap((t) => t.perks));
    const antiBarrier = perks.filter((p) => p.name.toLowerCase().includes("anti-barrier"));
    expect(antiBarrier.length, "manifest must contain anti-barrier artifact perks").toBeGreaterThan(0);
    expect(antiBarrier.some((p) => p.tags.championStuns?.includes("barrier"))).toBe(true);
  });
});
```

- [ ] **Step 3: Retarget the weapon curated-resolution test to the hash path**

The existing test (`tests/synergy/weapon-curated-resolution.test.ts`) asserts the **name bridge**. The side table is now the primary path, so it should assert that — while still permitting the name fallback. Replace the body of the `for` loop (lines 20-26) with:

```ts
  for (const [name, bucket, keyword] of CURATED) {
    it(`${name} resolves to ${bucket}:${keyword} by plug hash`, () => {
      // Find the plug by name in the real weapon corpus, then resolve its TAGS BY HASH.
      const plug = ds.weapons
        .flatMap((w) => w.perkColumns.flatMap((c) => c.plugs))
        .find((p) => p.name === name);
      expect(plug, `${name} must exist as a weapon plug`).toBeDefined();
      const tags = lookup.plugTags(plug!.hash) ?? lookup.perkByName(name)?.tags;
      expect(tags, `${name} must resolve tags`).toBeDefined();
      expect(tags![bucket]).toContain(keyword);
    });
  }
```

This needs the dataset itself, not just the lookup — change the loader `it` (line 18) to a `beforeAll` that keeps both:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import type { DerivedDataset } from "@/lib/types";

describe("weapon plug tag resolution — curated (real data)", () => {
  let ds: DerivedDataset;
  let lookup: Lookup;

  beforeAll(async () => {
    ds = await loadDataset();
    lookup = createLookup(ds);
  });
```

- [ ] **Step 4: Run the new tests**

Run: `npx vitest run tests/dataset.contract.test.ts tests/synergy/weapon-curated-resolution.test.ts`
Expected: PASS. A floor failure here means either the floor was set above the measured value (fix the constant against the spec) or a signal genuinely did not land (go back to Task 6, Step 4).

- [ ] **Step 5: Run the full verification trio**

Run: `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`
Expected: all green. Report the final test count and file count.

- [ ] **Step 6: Commit**

```bash
git add tests/dataset.contract.test.ts tests/synergy/weapon-curated-resolution.test.ts
git commit -m "test: contract + curated gates for the slice-2a dataset signals

Measured floors (not '> 0') for exotic tag coverage, exoticPerkHash coverage,
mod slot restriction, plug-tag table size, and champion extraction, plus the
SP2 artifact-structure invariant and a check that champion keywords never
leak into the producer/consumer graph. Curated weapon resolution now asserts
the plug-hash path with the name bridge as fallback."
```

---

## After the plan

Slice 2a ends here. **Slice 2b (the solver half) gets its own brainstorm → spec → plan**, designed against the measured data this slice produced — that sequencing was the point of splitting. Before starting it, refresh `docs/HANDOFF.md` with the measured counts, the new floors, and whatever churn Task 6 absorbed.
