# Phase 1 Feasibility Validator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a feasibility validator that checks a (partial) `Build` against Destiny 2 hard rules + tool baseline requirements, returning structured violations.

**Architecture:** A rule registry (Approach A): each hard rule is a small pure function `(build, lookup) => Violation[]`, grouped into per-domain modules (subclass/weapons/armor/artifact) and concatenated by `validateBuild`. Rules depend on a narrow injectable `Lookup` interface (hash→entity accessors), so unit tests use hand-written stubs — no dataset, no filesystem.

**Tech Stack:** TypeScript (strict), Vitest, `bungie-api-ts` (types only). Reads the Phase 0 derived dataset via `src/lib/data`.

**Spec:** `docs/superpowers/specs/2026-07-23-phase1-feasibility-validator-design.md`

## Global Constraints

- TypeScript strict; ESM; import shared types via the `@/*` alias (→ `src/`).
- **Never use `bungie-api-ts` `const enum`s as runtime values** (they're ambient, erased by esbuild). Map their numeric values with local literals + comments.
- Vitest for all tests (`pnpm test`). Rules are unit-tested with stub `Lookup` — no `loadDataset`/filesystem except the one integration test.
- All v1 violations use `category: "game"`. `"policy"` exists in the type but is unused (reserved for Phase 2).
- `MAX_ASPECTS = 2` (documented game constant).
- Commit after each task. The user owns commits — but this plan commits per task as normal dev flow on the current branch.
- `pnpm ingest` needs `BUNGIE_API_KEY` (in `.env`); a re-ingest is required only in Task 1.

---

## Execution status (updated 2026-07-23)

- ✅ Task 1 — `6b2632a` (reviewed; dummy-item exclusion added during execution)
- ✅ Task 2 — `df73844` (reviewed)
- ✅ Task 3 — `00969e0` (reviewed)
- ⏭️ Task 4 — next (base `00969e0`)
- Tasks 5–7 pending. Baseline: `pnpm test` 18/18, tsc + eslint clean. Resume via `docs/HANDOFF.md`.

---

### Task 1: Add `ammoType` to Weapon (ingestion pre-step)

**Files:**
- Modify: `src/lib/types/entities.ts` (add `ammoType` to `Weapon`)
- Modify: `scripts/ingest/transform.ts` (`transformWeapons` — populate `ammoType`)
- Modify: `scripts/ingest/classify.ts` (exclude dummy items from `isWeapon`/`isArmor`)
- Modify: `tests/dataset.smoke.test.ts` (assert weapons carry a valid `ammoType`)

> **Note (discovered during execution):** the Manifest includes many *dummy*
> weapon/armor copies (itemCategory "Dummies", `itemType` 20) with bogus data —
> e.g. dummy Jade Rabbits with Heavy ammo in the Kinetic slot. These must be
> excluded from `isWeapon`/`isArmor` (resolve the "Dummies" category by name and
> reject it, plus `itemType === 20`). This both upholds "non-Power weapons are
> never Heavy" and removes large duplicate pollution from the dataset.

**Interfaces:**
- Produces: `Weapon.ammoType: "primary" | "special" | "heavy"`

- [ ] **Step 1: Add the failing smoke assertion**

In `tests/dataset.smoke.test.ts`, inside the `describe.runIf(hasDataset)("derived dataset", …)` block, add:

```ts
  it("weapons carry a valid ammo type", () => {
    const valid = new Set(["primary", "special", "heavy"]);
    expect(ds.weapons.every((w) => valid.has(w.ammoType))).toBe(true);
    // Non-Power weapons never use Heavy ammo (requires dummy items to be
    // excluded from weapon classification — see classify.ts isDummy).
    const powerless = ds.weapons.filter((w) => w.slot !== "power");
    expect(powerless.every((w) => w.ammoType !== "heavy")).toBe(true);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test`
Expected: FAIL — `ammoType` is `undefined` on emitted weapons (type error at compile or `has(undefined)` false). (The dataset predates the field.)

- [ ] **Step 3: Add the field to the `Weapon` type**

In `src/lib/types/entities.ts`, add to the `Weapon` interface (after `damageType`):

```ts
  /** Ammo type, from equippingBlock.ammoType. Drives the ammo-composition rule. */
  ammoType: "primary" | "special" | "heavy";
```

- [ ] **Step 4: Populate it in the transform**

In `scripts/ingest/transform.ts`, inside `transformWeapons`, above the `out.push({ … })` for the weapon, add:

```ts
    // DestinyAmmunitionType is a const enum (no runtime value): 1 Primary, 2 Special, 3 Heavy.
    const AMMO: Record<number, "primary" | "special" | "heavy"> = {
      1: "primary",
      2: "special",
      3: "heavy",
    };
    const ammoType = AMMO[item.equippingBlock?.ammoType ?? 0] ?? "primary";
```

Then add `ammoType,` to the pushed weapon object (next to `damageType`).

- [ ] **Step 5: Re-ingest**

Run: `NODE_OPTIONS="--max-old-space-size=2048" pnpm ingest --force`
Expected: `✓ Ingest complete` with `weapons 2481` (count unchanged).

- [ ] **Step 6: Run tests to verify pass**

Run: `pnpm test`
Expected: PASS (all smoke tests, including the new ammo assertion).

- [ ] **Step 7: Commit**

```bash
git add src/lib/types/entities.ts scripts/ingest/transform.ts tests/dataset.smoke.test.ts data/
git commit -m "Add ammoType to Weapon (Phase 1 pre-step)"
```

---

### Task 2: Validation core — types, Lookup, validateBuild

**Files:**
- Create: `src/lib/validation/types.ts`
- Create: `src/lib/validation/lookup.ts`
- Create: `src/lib/validation/index.ts`
- Test: `tests/validation/core.test.ts`

**Interfaces:**
- Consumes: `DerivedDataset`, entity types from `@/lib/types`.
- Produces:
  - `ViolationCategory`, `ViolationCode`, `ViolationSubject`, `Violation`, `ValidationResult`, `Lookup`, `Rule` (types)
  - `createLookup(dataset: DerivedDataset): Lookup`
  - `validateBuild(build: Build, lookup: Lookup, rules: readonly Rule[]): ValidationResult`

- [ ] **Step 1: Write the types**

Create `src/lib/validation/types.ts`:

```ts
import type {
  Armor,
  ArmorSet,
  Artifact,
  Aspect,
  Build,
  Fragment,
  Hash,
  Subclass,
  Weapon,
} from "@/lib/types";

export type ViolationCategory = "game" | "policy";

export type ViolationCode =
  | "ASPECT_OVER_LIMIT"
  | "ASPECT_UNDERFILLED"
  | "FRAGMENT_OVER_CAP"
  | "FRAGMENT_UNDERFILLED"
  | "ELEMENT_MISMATCH"
  | "PERK_NOT_IN_POOL"
  | "PERK_COLUMN_CONFLICT"
  | "WEAPON_SLOT_MISMATCH"
  | "DUPLICATE_WEAPON_SLOT"
  | "DOUBLE_PRIMARY_AMMO"
  | "MULTIPLE_EXOTIC_ARMOR"
  | "MISSING_EXOTIC_ARMOR"
  | "ARMOR_CLASS_MISMATCH"
  | "DUPLICATE_ARMOR_SLOT"
  | "SET_COUNT_INVALID"
  | "ARTIFACT_TIER_OVER_CAP"
  | "ARTIFACT_TIER_UNDERFILLED"
  | "ARTIFACT_DUPLICATE_PERK"
  | "ARTIFACT_PERK_UNKNOWN";

export interface ViolationSubject {
  kind:
    | "subclass"
    | "aspect"
    | "fragment"
    | "weapon"
    | "armor"
    | "armorSet"
    | "artifact";
  hash?: Hash;
  slot?: string;
}

export interface Violation {
  code: ViolationCode;
  category: ViolationCategory;
  message: string;
  subject: ViolationSubject;
}

export interface ValidationResult {
  valid: boolean;
  violations: Violation[];
}

/** Narrow read surface the rules depend on (dependency-injection seam). */
export interface Lookup {
  weapon(hash: Hash): Weapon | undefined;
  armor(hash: Hash): Armor | undefined;
  armorSet(hash: Hash): ArmorSet | undefined;
  aspect(hash: Hash): Aspect | undefined;
  fragment(hash: Hash): Fragment | undefined;
  subclass(hash: Hash): Subclass | undefined;
  artifact(hash: Hash): Artifact | undefined;
}

export type Rule = (build: Build, lookup: Lookup) => Violation[];
```

- [ ] **Step 2: Write the failing core test**

Create `tests/validation/core.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { Build } from "@/lib/types";
import { createLookup, validateBuild } from "@/lib/validation";
import type { Lookup, Rule } from "@/lib/validation/types";

const emptyBuild: Build = {
  subclass: { aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
};

const stubLookup = {} as Lookup;

describe("validateBuild", () => {
  it("is valid when no rules fire", () => {
    const result = validateBuild(emptyBuild, stubLookup, []);
    expect(result).toEqual({ valid: true, violations: [] });
  });

  it("concatenates rule output and invalidates on a game violation", () => {
    const rule: Rule = () => [
      { code: "ELEMENT_MISMATCH", category: "game", message: "x", subject: { kind: "aspect" } },
    ];
    const result = validateBuild(emptyBuild, stubLookup, [rule]);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
  });

  it("stays valid when only policy violations are present", () => {
    const rule: Rule = () => [
      { code: "ELEMENT_MISMATCH", category: "policy", message: "x", subject: { kind: "aspect" } },
    ];
    expect(validateBuild(emptyBuild, stubLookup, [rule]).valid).toBe(true);
  });
});

describe("createLookup", () => {
  it("indexes entities by hash", () => {
    const lookup = createLookup({
      weapons: [{ hash: 7, name: "W" } as never],
      armor: [],
      armorSets: [],
      aspects: [],
      fragments: [],
      subclasses: [],
      artifacts: [],
    } as never);
    expect(lookup.weapon(7)?.name).toBe("W");
    expect(lookup.weapon(999)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm test tests/validation/core.test.ts`
Expected: FAIL — `@/lib/validation` has no `createLookup`/`validateBuild` exports.

- [ ] **Step 4: Implement `createLookup`**

Create `src/lib/validation/lookup.ts`:

```ts
import type { DerivedDataset, Hash } from "@/lib/types";

import type { Lookup } from "./types";

function indexByHash<T extends { hash: Hash }>(items: T[]): Map<Hash, T> {
  const map = new Map<Hash, T>();
  for (const item of items) map.set(item.hash, item);
  return map;
}

/** Build the read-only Lookup from a loaded dataset. */
export function createLookup(dataset: DerivedDataset): Lookup {
  const weapons = indexByHash(dataset.weapons);
  const armor = indexByHash(dataset.armor);
  const armorSets = indexByHash(dataset.armorSets);
  const aspects = indexByHash(dataset.aspects);
  const fragments = indexByHash(dataset.fragments);
  const subclasses = indexByHash(dataset.subclasses);
  const artifacts = indexByHash(dataset.artifacts);

  return {
    weapon: (hash) => weapons.get(hash),
    armor: (hash) => armor.get(hash),
    armorSet: (hash) => armorSets.get(hash),
    aspect: (hash) => aspects.get(hash),
    fragment: (hash) => fragments.get(hash),
    subclass: (hash) => subclasses.get(hash),
    artifact: (hash) => artifacts.get(hash),
  };
}
```

- [ ] **Step 5: Implement `validateBuild` + barrel**

Create `src/lib/validation/index.ts`:

```ts
import type { Build } from "@/lib/types";

import type { Lookup, Rule, ValidationResult } from "./types";

export { createLookup } from "./lookup";
export type {
  Lookup,
  Rule,
  Violation,
  ValidationResult,
  ViolationCategory,
  ViolationCode,
  ViolationSubject,
} from "./types";

/**
 * Run every rule over the build and aggregate violations.
 * `valid` is true iff there are no `game`-category violations.
 */
export function validateBuild(
  build: Build,
  lookup: Lookup,
  rules: readonly Rule[],
): ValidationResult {
  const violations = rules.flatMap((rule) => rule(build, lookup));
  return {
    valid: !violations.some((v) => v.category === "game"),
    violations,
  };
}
```

- [ ] **Step 6: Run tests to verify pass**

Run: `pnpm test tests/validation/core.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck + commit**

```bash
pnpm exec tsc --noEmit
git add src/lib/validation tests/validation/core.test.ts
git commit -m "Add validation core: types, Lookup, validateBuild"
```

---

### Task 3: Subclass rules

**Files:**
- Create: `src/lib/validation/subclass.ts`
- Test: `tests/validation/subclass.test.ts`

**Interfaces:**
- Consumes: `Rule`, `Lookup`, `Violation` from `./types`; `Build` from `@/lib/types`.
- Produces: `export const subclassRules: Rule[]`; `export const MAX_ASPECTS = 2`.

- [ ] **Step 1: Write the failing tests**

Create `tests/validation/subclass.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { Build } from "@/lib/types";
import type { Lookup } from "@/lib/validation/types";
import { subclassRules } from "@/lib/validation/subclass";

function run(build: Build, lookup: Partial<Lookup>): string[] {
  return subclassRules.flatMap((r) => r(build, lookup as Lookup)).map((v) => v.code);
}

const base: Build = {
  subclass: { aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
};

const lookup: Partial<Lookup> = {
  aspect: (h) =>
    ({ 1: { hash: 1, element: "void", fragmentSlots: 2 }, 2: { hash: 2, element: "arc", fragmentSlots: 1 } } as never)[h],
  fragment: (h) => ({ 10: { hash: 10, element: "void" }, 11: { hash: 11, element: "arc" } } as never)[h],
};

it("is silent when subclass is not engaged", () => {
  expect(run(base, lookup)).toEqual([]);
});

it("flags fewer than 2 aspects once engaged", () => {
  const b = { ...base, subclass: { element: "void", aspectHashes: [1], fragmentHashes: [] } };
  expect(run(b, lookup)).toContain("ASPECT_UNDERFILLED");
});

it("flags more than 2 aspects", () => {
  const b = { ...base, subclass: { element: "void", aspectHashes: [1, 1, 1], fragmentHashes: [] } };
  expect(run(b, lookup)).toContain("ASPECT_OVER_LIMIT");
});

it("flags fragments over/under the granted slots", () => {
  const over = { ...base, subclass: { element: "void", aspectHashes: [1], fragmentHashes: [10, 10, 10] } };
  expect(run(over, lookup)).toContain("FRAGMENT_OVER_CAP");
  const under = { ...base, subclass: { element: "void", aspectHashes: [1], fragmentHashes: [] } };
  expect(run(under, lookup)).toContain("FRAGMENT_UNDERFILLED");
});

it("flags element mismatch on aspects and fragments", () => {
  const b = { ...base, subclass: { element: "void", aspectHashes: [2], fragmentHashes: [11] } };
  const codes = run(b, lookup);
  expect(codes.filter((c) => c === "ELEMENT_MISMATCH")).toHaveLength(2);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/validation/subclass.test.ts`
Expected: FAIL — `@/lib/validation/subclass` does not exist.

- [ ] **Step 3: Implement the rules**

Create `src/lib/validation/subclass.ts`:

```ts
import type { Build } from "@/lib/types";

import type { Rule, Violation } from "./types";

export const MAX_ASPECTS = 2;

/** Subclass is "engaged" once the user has committed to building it. */
function engaged(build: Build): boolean {
  const s = build.subclass;
  return Boolean(
    s.element ||
      s.superHash !== undefined ||
      s.aspectHashes.length > 0 ||
      s.fragmentHashes.length > 0,
  );
}

const aspectCount: Rule = (build) => {
  if (!engaged(build)) return [];
  const n = build.subclass.aspectHashes.length;
  const out: Violation[] = [];
  if (n > MAX_ASPECTS) {
    out.push({
      code: "ASPECT_OVER_LIMIT",
      category: "game",
      message: `A subclass allows at most ${MAX_ASPECTS} aspects; ${n} selected.`,
      subject: { kind: "subclass" },
    });
  }
  if (n < MAX_ASPECTS) {
    out.push({
      code: "ASPECT_UNDERFILLED",
      category: "game",
      message: `Use all ${MAX_ASPECTS} aspect slots; only ${n} selected.`,
      subject: { kind: "subclass" },
    });
  }
  return out;
};

const fragmentCount: Rule = (build, lookup) => {
  const { aspectHashes, fragmentHashes } = build.subclass;
  if (aspectHashes.length === 0) return [];
  const slots = aspectHashes.reduce(
    (sum, h) => sum + (lookup.aspect(h)?.fragmentSlots ?? 0),
    0,
  );
  const n = fragmentHashes.length;
  const out: Violation[] = [];
  if (n > slots) {
    out.push({
      code: "FRAGMENT_OVER_CAP",
      category: "game",
      message: `Equipped aspects grant ${slots} fragment slots; ${n} selected.`,
      subject: { kind: "subclass" },
    });
  }
  if (n < slots) {
    out.push({
      code: "FRAGMENT_UNDERFILLED",
      category: "game",
      message: `Fill all ${slots} fragment slots; only ${n} selected.`,
      subject: { kind: "subclass" },
    });
  }
  return out;
};

const elementConsistency: Rule = (build, lookup) => {
  const element = build.subclass.element;
  if (!element) return [];
  const out: Violation[] = [];
  for (const h of build.subclass.aspectHashes) {
    const aspect = lookup.aspect(h);
    if (aspect && aspect.element !== element) {
      out.push({
        code: "ELEMENT_MISMATCH",
        category: "game",
        message: `Aspect "${aspect.name}" is ${aspect.element}, not ${element}.`,
        subject: { kind: "aspect", hash: h },
      });
    }
  }
  for (const h of build.subclass.fragmentHashes) {
    const fragment = lookup.fragment(h);
    if (fragment && fragment.element !== element) {
      out.push({
        code: "ELEMENT_MISMATCH",
        category: "game",
        message: `Fragment "${fragment.name}" is ${fragment.element}, not ${element}.`,
        subject: { kind: "fragment", hash: h },
      });
    }
  }
  return out;
};

export const subclassRules: Rule[] = [aspectCount, fragmentCount, elementConsistency];
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm test tests/validation/subclass.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/subclass.ts tests/validation/subclass.test.ts
git commit -m "Add subclass validation rules"
```

---

### Task 4: Weapon rules

**Files:**
- Create: `src/lib/validation/weapons.ts`
- Test: `tests/validation/weapons.test.ts`

**Interfaces:**
- Consumes: `Rule`, `Lookup`, `Violation` from `./types`; `Build`, `WeaponSlot` from `@/lib/types`.
- Produces: `export const weaponRules: Rule[]`.

- [ ] **Step 1: Write the failing tests**

Create `tests/validation/weapons.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { Build } from "@/lib/types";
import type { Lookup } from "@/lib/validation/types";
import { weaponRules } from "@/lib/validation/weapons";

function run(build: Build, lookup: Partial<Lookup>): string[] {
  return weaponRules.flatMap((r) => r(build, lookup as Lookup)).map((v) => v.code);
}

const base: Build = {
  subclass: { aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
};

// hash 100: energy weapon, special ammo, columns [ {idx0: A,B}, {idx1: C} ]
// hash 200: kinetic weapon, primary ammo
const lookup: Partial<Lookup> = {
  weapon: (h) =>
    (({
      100: {
        hash: 100, name: "Gun", slot: "energy", ammoType: "special",
        perkColumns: [
          { socketIndex: 0, plugs: [{ hash: 1, name: "Rampage" }, { hash: 2, name: "Kill Clip" }] },
          { socketIndex: 1, plugs: [{ hash: 3, name: "Outlaw" }] },
        ],
      },
      200: { hash: 200, name: "Hand Cannon", slot: "kinetic", ammoType: "primary", perkColumns: [] },
    }) as never)[h],
};

it("flags a perk not in the weapon's pool", () => {
  const b = { ...base, weapons: [{ slot: "energy", itemHash: 100, perkConstraints: [{ perkName: "Frenzy" }] }] };
  expect(run(b, lookup)).toContain("PERK_NOT_IN_POOL");
});

it("flags two requested perks that share one column", () => {
  const b = { ...base, weapons: [{ slot: "energy", itemHash: 100, perkConstraints: [{ perkName: "Rampage" }, { perkName: "Kill Clip" }] }] };
  expect(run(b, lookup)).toContain("PERK_COLUMN_CONFLICT");
});

it("allows perks in different columns", () => {
  const b = { ...base, weapons: [{ slot: "energy", itemHash: 100, perkConstraints: [{ perkName: "Rampage" }, { perkName: "Outlaw" }] }] };
  expect(run(b, lookup)).not.toContain("PERK_COLUMN_CONFLICT");
});

it("flags a weapon placed in the wrong slot", () => {
  const b = { ...base, weapons: [{ slot: "power", itemHash: 100, perkConstraints: [] }] };
  expect(run(b, lookup)).toContain("WEAPON_SLOT_MISMATCH");
});

it("flags two weapons in the same slot", () => {
  const b = { ...base, weapons: [
    { slot: "kinetic", itemHash: 200, perkConstraints: [] },
    { slot: "kinetic", itemHash: 200, perkConstraints: [] },
  ] };
  expect(run(b, lookup)).toContain("DUPLICATE_WEAPON_SLOT");
});

it("flags double-primary but allows a special in the mix", () => {
  const doublePrimary = { ...base, weapons: [
    { slot: "kinetic", itemHash: 200, perkConstraints: [] },
    { slot: "energy", itemHash: 200, perkConstraints: [] },
  ] };
  expect(run(doublePrimary, lookup)).toContain("DOUBLE_PRIMARY_AMMO");

  const withSpecial = { ...base, weapons: [
    { slot: "kinetic", itemHash: 200, perkConstraints: [] },
    { slot: "energy", itemHash: 100, perkConstraints: [] },
  ] };
  expect(run(withSpecial, lookup)).not.toContain("DOUBLE_PRIMARY_AMMO");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/validation/weapons.test.ts`
Expected: FAIL — `@/lib/validation/weapons` does not exist.

- [ ] **Step 3: Implement the rules**

Create `src/lib/validation/weapons.ts`:

```ts
import type { Build, WeaponSlot } from "@/lib/types";

import type { Lookup, Rule, Violation } from "./types";
import type { PerkConstraint } from "@/lib/types";
import type { WeaponPerkColumn } from "@/lib/types";

/** Columns of `weapon` that can roll the constrained perk. */
function columnsFor(
  columns: WeaponPerkColumn[],
  constraint: PerkConstraint,
): WeaponPerkColumn[] {
  return columns.filter((col) =>
    col.plugs.some(
      (p) =>
        (constraint.perkHash !== undefined && p.hash === constraint.perkHash) ||
        (constraint.perkName !== undefined &&
          p.name.toLowerCase() === constraint.perkName.toLowerCase()),
    ),
  );
}

const perksAndSlot: Rule = (build, lookup) => {
  const out: Violation[] = [];
  for (const sel of build.weapons) {
    if (sel.itemHash === undefined) continue;
    const weapon = lookup.weapon(sel.itemHash);
    if (!weapon) continue;

    if (weapon.slot !== sel.slot) {
      out.push({
        code: "WEAPON_SLOT_MISMATCH",
        category: "game",
        message: `"${weapon.name}" is a ${weapon.slot} weapon but placed in ${sel.slot}.`,
        subject: { kind: "weapon", hash: sel.itemHash, slot: sel.slot },
      });
    }

    // Count requested perks whose ONLY column is a given socket index.
    const pinnedByColumn = new Map<number, number>();
    for (const constraint of sel.perkConstraints) {
      const cols = columnsFor(weapon.perkColumns, constraint);
      if (cols.length === 0) {
        out.push({
          code: "PERK_NOT_IN_POOL",
          category: "game",
          message: `"${weapon.name}" can't roll a requested perk.`,
          subject: { kind: "weapon", hash: sel.itemHash },
        });
      } else if (cols.length === 1) {
        const idx = cols[0].socketIndex;
        pinnedByColumn.set(idx, (pinnedByColumn.get(idx) ?? 0) + 1);
      }
    }
    for (const [idx, count] of pinnedByColumn) {
      if (count > 1) {
        out.push({
          code: "PERK_COLUMN_CONFLICT",
          category: "game",
          message: `"${weapon.name}": ${count} requested perks share column ${idx} and can't be equipped together.`,
          subject: { kind: "weapon", hash: sel.itemHash },
        });
      }
    }
  }
  return out;
};

const slotUniqueness: Rule = (build) => {
  const counts = new Map<WeaponSlot, number>();
  for (const sel of build.weapons) {
    counts.set(sel.slot, (counts.get(sel.slot) ?? 0) + 1);
  }
  const out: Violation[] = [];
  for (const [slot, count] of counts) {
    if (count > 1) {
      out.push({
        code: "DUPLICATE_WEAPON_SLOT",
        category: "game",
        message: `${count} weapons in the ${slot} slot; only one allowed.`,
        subject: { kind: "weapon", slot },
      });
    }
  }
  return out;
};

const noDoublePrimary: Rule = (build, lookup) => {
  const nonPower = build.weapons.filter(
    (w) => w.slot !== "power" && w.itemHash !== undefined,
  );
  if (nonPower.length < 2) return [];
  const ammo = nonPower
    .map((w) => lookup.weapon(w.itemHash as number)?.ammoType)
    .filter((a): a is "primary" | "special" | "heavy" => Boolean(a));
  if (ammo.length < 2) return [];
  if (!ammo.some((a) => a === "special")) {
    return [
      {
        code: "DOUBLE_PRIMARY_AMMO",
        category: "game",
        message: "At least one non-Power weapon must use Special ammo (no double-Primary).",
        subject: { kind: "weapon" },
      },
    ];
  }
  return [];
};

export const weaponRules: Rule[] = [perksAndSlot, slotUniqueness, noDoublePrimary];
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm test tests/validation/weapons.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/weapons.ts tests/validation/weapons.test.ts
git commit -m "Add weapon validation rules"
```

---

### Task 5: Armor rules

**Files:**
- Create: `src/lib/validation/armor.ts`
- Test: `tests/validation/armor.test.ts`

**Interfaces:**
- Consumes: `Rule`, `Lookup`, `Violation` from `./types`; `Build`, `ArmorSlot` from `@/lib/types`.
- Produces: `export const armorRules: Rule[]`.

- [ ] **Step 1: Write the failing tests**

Create `tests/validation/armor.test.ts`:

```ts
import { expect, it } from "vitest";

import type { Build } from "@/lib/types";
import type { Lookup } from "@/lib/validation/types";
import { armorRules } from "@/lib/validation/armor";

function run(build: Build, lookup: Partial<Lookup>): string[] {
  return armorRules.flatMap((r) => r(build, lookup as Lookup)).map((v) => v.code);
}

const base: Build = {
  subclass: { aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
};

// helper armor entities
const A = (hash: number, slot: string, tier: string, classType: string, setHash?: number) =>
  ({ hash, name: `A${hash}`, slot, tier, classType, setHash }) as never;

const lookup: Partial<Lookup> = {
  armor: (h) =>
    (({
      1: A(1, "helmet", "exotic", "titan"),
      2: A(2, "arms", "exotic", "titan"),
      3: A(3, "chest", "legendary", "hunter"),
      4: A(4, "helmet", "legendary", "titan", 900),
      5: A(5, "arms", "legendary", "titan", 900),
    }) as never)[h],
};

it("flags more than one exotic", () => {
  const b = { ...base, armor: { ...base.armor, pieces: [
    { slot: "helmet", itemHash: 1 }, { slot: "arms", itemHash: 2 },
  ] } };
  expect(run(b, lookup)).toContain("MULTIPLE_EXOTIC_ARMOR");
});

it("flags mixed classes", () => {
  const b = { ...base, armor: { ...base.armor, pieces: [
    { slot: "helmet", itemHash: 1 }, { slot: "chest", itemHash: 3 },
  ] } };
  expect(run(b, lookup)).toContain("ARMOR_CLASS_MISMATCH");
});

it("flags two pieces in the same slot", () => {
  const b = { ...base, armor: { ...base.armor, pieces: [
    { slot: "helmet", itemHash: 1 }, { slot: "helmet", itemHash: 4 },
  ] } };
  expect(run(b, lookup)).toContain("DUPLICATE_ARMOR_SLOT");
});

it("flags a set bonus without enough pieces", () => {
  const b = { ...base, armor: { ...base.armor,
    pieces: [{ slot: "helmet", itemHash: 4 }],
    setBonuses: [{ setHash: 900, requiredCount: 2 }],
  } };
  expect(run(b, lookup)).toContain("SET_COUNT_INVALID");
});

it("flags a complete 5-piece set with no exotic", () => {
  const legendary = (h: number, slot: string) => ({ slot, itemHash: h });
  const lk: Partial<Lookup> = { armor: (h) => A(h, "x", "legendary", "titan") };
  const b = { ...base, armor: { ...base.armor, pieces: [
    legendary(10, "helmet"), legendary(11, "arms"), legendary(12, "chest"),
    legendary(13, "legs"), legendary(14, "class"),
  ] } };
  expect(run(b, lk)).toContain("MISSING_EXOTIC_ARMOR");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/validation/armor.test.ts`
Expected: FAIL — `@/lib/validation/armor` does not exist.

- [ ] **Step 3: Implement the rules**

Create `src/lib/validation/armor.ts`:

```ts
import type { ArmorSlot, Build } from "@/lib/types";

import type { Lookup, Rule, Violation } from "./types";

function specifiedPieces(build: Build) {
  return build.armor.pieces.filter((p) => p.itemHash !== undefined);
}

const exoticCount: Rule = (build, lookup) => {
  const pieces = specifiedPieces(build);
  if (pieces.length === 0) return [];
  const exotics = pieces.filter(
    (p) => lookup.armor(p.itemHash as number)?.tier === "exotic",
  );
  const out: Violation[] = [];
  if (exotics.length > 1) {
    out.push({
      code: "MULTIPLE_EXOTIC_ARMOR",
      category: "game",
      message: `Only one exotic armor piece allowed; ${exotics.length} selected.`,
      subject: { kind: "armor" },
    });
  }
  if (pieces.length >= 5 && exotics.length === 0) {
    out.push({
      code: "MISSING_EXOTIC_ARMOR",
      category: "game",
      message: "A complete armor set should include exactly one exotic.",
      subject: { kind: "armor" },
    });
  }
  return out;
};

const classConsistency: Rule = (build, lookup) => {
  const pieces = specifiedPieces(build);
  const classes = new Set(
    pieces
      .map((p) => lookup.armor(p.itemHash as number)?.classType)
      .filter((c): c is string => Boolean(c) && c !== "any"),
  );
  if (classes.size > 1) {
    return [
      {
        code: "ARMOR_CLASS_MISMATCH",
        category: "game",
        message: `Armor pieces span multiple classes: ${[...classes].join(", ")}.`,
        subject: { kind: "armor" },
      },
    ];
  }
  return [];
};

const slotUniqueness: Rule = (build) => {
  const counts = new Map<ArmorSlot, number>();
  for (const p of build.armor.pieces) {
    if (p.itemHash === undefined) continue;
    counts.set(p.slot, (counts.get(p.slot) ?? 0) + 1);
  }
  const out: Violation[] = [];
  for (const [slot, count] of counts) {
    if (count > 1) {
      out.push({
        code: "DUPLICATE_ARMOR_SLOT",
        category: "game",
        message: `${count} armor pieces in the ${slot} slot; only one allowed.`,
        subject: { kind: "armor", slot },
      });
    }
  }
  return out;
};

const setBonusCounts: Rule = (build, lookup) => {
  const pieces = specifiedPieces(build);
  const bySet = new Map<number, number>();
  for (const p of pieces) {
    const setHash = lookup.armor(p.itemHash as number)?.setHash;
    if (setHash !== undefined) bySet.set(setHash, (bySet.get(setHash) ?? 0) + 1);
  }
  const out: Violation[] = [];
  for (const bonus of build.armor.setBonuses) {
    const have = bySet.get(bonus.setHash) ?? 0;
    if (have < bonus.requiredCount) {
      out.push({
        code: "SET_COUNT_INVALID",
        category: "game",
        message: `Set bonus needs ${bonus.requiredCount} pieces but only ${have} equipped.`,
        subject: { kind: "armorSet", hash: bonus.setHash },
      });
    }
  }
  const hasExotic = pieces.some(
    (p) => lookup.armor(p.itemHash as number)?.tier === "exotic",
  );
  if (hasExotic) {
    for (const [setHash, count] of bySet) {
      if (count > 4) {
        out.push({
          code: "SET_COUNT_INVALID",
          category: "game",
          message: `With an exotic equipped, at most 4 pieces can share a set (${count} share one).`,
          subject: { kind: "armorSet", hash: setHash },
        });
      }
    }
  }
  return out;
};

export const armorRules: Rule[] = [
  exoticCount,
  classConsistency,
  slotUniqueness,
  setBonusCounts,
];
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm test tests/validation/armor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/armor.ts tests/validation/armor.test.ts
git commit -m "Add armor validation rules"
```

---

### Task 6: Artifact rules

**Files:**
- Create: `src/lib/validation/artifact.ts`
- Test: `tests/validation/artifact.test.ts`

**Interfaces:**
- Consumes: `Rule`, `Lookup`, `Violation` from `./types`; `Build` from `@/lib/types`.
- Produces: `export const artifactRules: Rule[]`.

- [ ] **Step 1: Write the failing tests**

Create `tests/validation/artifact.test.ts`:

```ts
import { expect, it } from "vitest";

import type { Build } from "@/lib/types";
import type { Lookup } from "@/lib/validation/types";
import { artifactRules } from "@/lib/validation/artifact";

function run(build: Build, lookup: Partial<Lookup>): string[] {
  return artifactRules.flatMap((r) => r(build, lookup as Lookup)).map((v) => v.code);
}

const base: Build = {
  subclass: { aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
};

// artifact 500: tiers with slots 2/3/2; perks 1,2 (t0), 3,4,5 (t1), 6,7 (t2)
const lookup: Partial<Lookup> = {
  artifact: (h) =>
    h === 500
      ? ({
          hash: 500, name: "Test Artifact",
          tiers: [
            { tierIndex: 0, slots: 2, perks: [{ hash: 1 }, { hash: 2 }] },
            { tierIndex: 1, slots: 3, perks: [{ hash: 3 }, { hash: 4 }, { hash: 5 }] },
            { tierIndex: 2, slots: 2, perks: [{ hash: 6 }, { hash: 7 }] },
          ],
        } as never)
      : undefined,
};

it("is silent when no artifact is pinned", () => {
  expect(run(base, lookup)).toEqual([]);
});

it("flags an unknown perk", () => {
  const b = { ...base, artifact: { artifactHash: 500, selectedPerkHashes: [1, 2, 3, 4, 5, 6, 999] } };
  expect(run(b, lookup)).toContain("ARTIFACT_PERK_UNKNOWN");
});

it("flags a duplicate perk", () => {
  const b = { ...base, artifact: { artifactHash: 500, selectedPerkHashes: [1, 1, 2, 3, 4, 5, 6] } };
  expect(run(b, lookup)).toContain("ARTIFACT_DUPLICATE_PERK");
});

it("flags under-filled tiers", () => {
  const b = { ...base, artifact: { artifactHash: 500, selectedPerkHashes: [1] } };
  expect(run(b, lookup)).toContain("ARTIFACT_TIER_UNDERFILLED");
});

it("is clean when all 7 slots (2/3/2) are filled with distinct valid perks", () => {
  const b = { ...base, artifact: { artifactHash: 500, selectedPerkHashes: [1, 2, 3, 4, 5, 6, 7] } };
  expect(run(b, lookup)).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/validation/artifact.test.ts`
Expected: FAIL — `@/lib/validation/artifact` does not exist.

- [ ] **Step 3: Implement the rules**

Create `src/lib/validation/artifact.ts`:

```ts
import type { Build } from "@/lib/types";

import type { Lookup, Rule, Violation } from "./types";

const perkMembership: Rule = (build, lookup) => {
  const { artifactHash, selectedPerkHashes } = build.artifact;
  if (artifactHash === undefined) return [];
  const artifact = lookup.artifact(artifactHash);
  if (!artifact) return [];

  const known = new Set<number>();
  for (const tier of artifact.tiers) for (const p of tier.perks) known.add(p.hash);

  const out: Violation[] = [];
  const seen = new Set<number>();
  for (const hash of selectedPerkHashes) {
    if (seen.has(hash)) {
      out.push({
        code: "ARTIFACT_DUPLICATE_PERK",
        category: "game",
        message: "An artifact perk is selected more than once.",
        subject: { kind: "artifact", hash },
      });
    }
    seen.add(hash);
    if (!known.has(hash)) {
      out.push({
        code: "ARTIFACT_PERK_UNKNOWN",
        category: "game",
        message: `A selected perk is not part of ${artifact.name}.`,
        subject: { kind: "artifact", hash },
      });
    }
  }
  return out;
};

const tierCapacity: Rule = (build, lookup) => {
  const { artifactHash, selectedPerkHashes } = build.artifact;
  if (artifactHash === undefined) return [];
  const artifact = lookup.artifact(artifactHash);
  if (!artifact) return [];

  // Map each perk hash to its tier index.
  const tierOf = new Map<number, number>();
  for (const tier of artifact.tiers) {
    for (const p of tier.perks) tierOf.set(p.hash, tier.tierIndex);
  }

  // Count distinct selected perks per tier.
  const perTier = new Map<number, number>();
  for (const hash of new Set(selectedPerkHashes)) {
    const idx = tierOf.get(hash);
    if (idx !== undefined) perTier.set(idx, (perTier.get(idx) ?? 0) + 1);
  }

  const out: Violation[] = [];
  for (const tier of artifact.tiers) {
    const n = perTier.get(tier.tierIndex) ?? 0;
    if (n > tier.slots) {
      out.push({
        code: "ARTIFACT_TIER_OVER_CAP",
        category: "game",
        message: `Tier ${tier.tierIndex + 1} allows ${tier.slots} perks; ${n} selected.`,
        subject: { kind: "artifact", hash: artifact.hash },
      });
    }
    if (n < tier.slots) {
      out.push({
        code: "ARTIFACT_TIER_UNDERFILLED",
        category: "game",
        message: `Fill all ${tier.slots} perks in tier ${tier.tierIndex + 1}; ${n} selected.`,
        subject: { kind: "artifact", hash: artifact.hash },
      });
    }
  }
  return out;
};

export const artifactRules: Rule[] = [perkMembership, tierCapacity];
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm test tests/validation/artifact.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/artifact.ts tests/validation/artifact.test.ts
git commit -m "Add artifact validation rules"
```

---

### Task 7: Register all rules + integration test

**Files:**
- Modify: `src/lib/validation/index.ts` (assemble `ALL_RULES`, default it in `validateBuild`)
- Test: `tests/validation/integration.test.ts`

**Interfaces:**
- Consumes: `subclassRules`, `weaponRules`, `armorRules`, `artifactRules`; `createLookup`, `loadDataset`.
- Produces: `export const ALL_RULES: Rule[]`; `validateBuild(build, lookup, rules?)` with `rules` defaulting to `ALL_RULES`.

- [ ] **Step 1: Register the domain rules**

Edit `src/lib/validation/index.ts`. Add imports at the top:

```ts
import { subclassRules } from "./subclass";
import { weaponRules } from "./weapons";
import { armorRules } from "./armor";
import { artifactRules } from "./artifact";
```

Add the registry (after the imports/exports):

```ts
/** Every hard rule, across all domains. */
export const ALL_RULES: Rule[] = [
  ...subclassRules,
  ...weaponRules,
  ...armorRules,
  ...artifactRules,
];
```

Change the `validateBuild` signature so `rules` defaults to `ALL_RULES`:

```ts
export function validateBuild(
  build: Build,
  lookup: Lookup,
  rules: readonly Rule[] = ALL_RULES,
): ValidationResult {
  const violations = rules.flatMap((rule) => rule(build, lookup));
  return {
    valid: !violations.some((v) => v.category === "game"),
    violations,
  };
}
```

- [ ] **Step 2: Write the failing integration test**

Create `tests/validation/integration.test.ts`. It derives a valid build from the real dataset, then breaks it:

```ts
import { existsSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import type { Build, DerivedDataset } from "@/lib/types";
import { createLookup, validateBuild, type Lookup } from "@/lib/validation";

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));

describe.runIf(hasDataset)("validateBuild (integration)", () => {
  let ds: DerivedDataset;
  let lookup: Lookup;

  beforeAll(async () => {
    ds = await loadDataset();
    lookup = createLookup(ds);
  });

  /** Build a minimal legal artifact loadout: fill 2/3/2 with distinct perks. */
  function fullArtifact(): Build["artifact"] {
    const artifact = ds.artifacts[0];
    const selectedPerkHashes = artifact.tiers.flatMap((t) =>
      t.perks.slice(0, t.slots).map((p) => p.hash),
    );
    return { artifactHash: artifact.hash, selectedPerkHashes };
  }

  it("passes a legal artifact selection", () => {
    const build: Build = {
      subclass: { aspectHashes: [], fragmentHashes: [] },
      weapons: [],
      armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
      artifact: fullArtifact(),
      constraints: [],
    };
    const result = validateBuild(build, lookup);
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("flags an over-capped artifact tier", () => {
    const artifact = ds.artifacts[0];
    // Take 3 perks from tier 0 (slots=2) → over cap; plus fill others to isolate the code.
    const t0 = artifact.tiers[0];
    const selectedPerkHashes = [
      ...t0.perks.slice(0, 3).map((p) => p.hash),
      ...artifact.tiers[1].perks.slice(0, artifact.tiers[1].slots).map((p) => p.hash),
      ...artifact.tiers[2].perks.slice(0, artifact.tiers[2].slots).map((p) => p.hash),
    ];
    const build: Build = {
      subclass: { aspectHashes: [], fragmentHashes: [] },
      weapons: [],
      armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
      artifact: { artifactHash: artifact.hash, selectedPerkHashes },
      constraints: [],
    };
    const result = validateBuild(build, lookup);
    expect(result.valid).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("ARTIFACT_TIER_OVER_CAP");
  });
});
```

- [ ] **Step 3: Run it to verify it fails, then passes**

Run: `pnpm test tests/validation/integration.test.ts`
Expected: initially FAIL if `ALL_RULES`/default not yet wired; after Step 1 is in place, PASS. (If the dataset is absent it SKIPS — that's acceptable, but locally it should run and pass.)

- [ ] **Step 4: Full verification**

Run: `pnpm exec tsc --noEmit && pnpm exec eslint scripts src tests && pnpm test`
Expected: tsc exit 0, eslint 0 problems, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/index.ts tests/validation/integration.test.ts
git commit -m "Register all validation rules + integration test"
```

---

## Self-Review

**Spec coverage:**
- §2 four domains → Tasks 3–6. ✓
- §2 deferrals (champions, one-exotic-weapon, mod energy, policy) → not implemented, documented. ✓
- §3 semantics (partial build, firing conditions, `valid` = no game) → engaged/pinned guards in each rule + `validateBuild` (Task 2). ✓
- §4 architecture (rule registry, DI Lookup) → Tasks 2 + 7. ✓
- §5 types → Task 2. ✓
- §6 every rule/code → Tasks 3–6 (all 19 codes covered). ✓
- §7 ammoType pre-step → Task 1. ✓
- §8 unit tests per rule + integration → Tasks 3–7. ✓
- §9 new peer module, no other changes → paths confined to `src/lib/validation` + Task 1 additions. ✓

**Placeholder scan:** No TBD/TODO; every code step has full code. ✓

**Type consistency:** `Rule`, `Lookup`, `Violation`, `ValidationResult` used identically across tasks; `validateBuild` signature evolves from required `rules` (Task 2) to defaulted `rules = ALL_RULES` (Task 7), noted explicitly. Entity field names (`fragmentSlots`, `perkColumns`, `tier`, `slots`, `setHash`, `ammoType`, `element`) match the Phase 0 types. ✓
