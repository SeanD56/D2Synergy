# Phase 2 · SP1 — Synergy Engine v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inert `getSynergies`/`scoreSynergy` stubs with a pure, dependency-injected rules-based synergy engine over the ingested keyword-tag substrate, plus a small set of soft `policy` advisories.

**Architecture:** A new `src/lib/synergy/` layer resolves a `Build` into tagged elements through an extended validation `Lookup` seam, matches producer→consumer keyword chains with an escalating (quadratic-in-depth) weight, adds element-coherence and trigger-alignment signals and a curated overlay, and exposes advisories as `policy` rules. The synergy layer depends on the validation layer, never the reverse.

**Tech Stack:** TypeScript (strict), Vitest, `pnpm`. `@/*` → `src/*`. No new dependencies.

## Global Constraints

- **Score invariant:** `scoreSynergy(...).score` MUST equal `Σ` of the `weight` of every returned `Synergy`. No hidden aggregate terms; multiplicativity lives inside individual chain weights.
- **Depth reward:** the i-th matched producer→consumer chain within one keyword is weighted `CHAIN_BASE · i` (escalating 1, 2, 3, …).
- **Weights (exact starting values):** `CHAIN_BASE = 1.0`, `ELEMENT_ALIGNED_MULT = 1.5`, `TRIGGER_SHARE = 0.5`, `TRIGGER_GROUP_CAP = 3`.
- **Policy never invalidates:** advisory violations use `category: "policy"`; `validateBuild`'s `valid` (which checks only `game`) must stay `true` under them.
- **Determinism:** all matching iterates keywords/triggers in sorted order and elements sorted by `hash` ascending; output is stable across runs regardless of collection order.
- **Self-pair-safe:** an element that both produces and consumes a keyword is never paired with itself (in chains, triggers, or advisories), but still cross-chains with other elements.
- **Layering:** `src/lib/synergy/` may import from `@/lib/validation/*` and `@/lib/types`; `@/lib/validation` must NOT import from `@/lib/synergy`.
- **No filesystem in the engine:** all data access goes through the injected `Lookup`.
- **Curated overlay in v1** is an empty, type-checked inline array (`CURATED_OVERLAY: OverlayEntry[] = []`); overlay entries require BOTH `fromHash` and `toHash`.

---

### Task 1: Extend the Lookup seam + Violation vocabulary

**Files:**
- Modify: `src/lib/validation/types.ts`
- Modify: `src/lib/validation/lookup.ts`
- Test: `tests/validation/lookup.test.ts`

**Interfaces:**
- Consumes: `DerivedDataset`, `Hash`, `Perk`, `Mod`, `ArtifactPerk`, `EMPTY_TAGS` from `@/lib/types`.
- Produces: `Lookup.perk(hash): Perk | undefined`, `Lookup.mod(hash): Mod | undefined`, `Lookup.artifactPerk(hash): ArtifactPerk | undefined`; `ViolationCode` gains `"UNUSED_PRODUCER" | "UNMET_CONSUMER"`; `ViolationSubject.kind` gains `"synergy"` and an optional `keyword?: string`.

- [ ] **Step 1: Write the failing test**

Create `tests/validation/lookup.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { EMPTY_TAGS, type DerivedDataset } from "@/lib/types";
import { createLookup } from "@/lib/validation";

const dataset = {
  weapons: [], armor: [], armorSets: [], aspects: [], fragments: [],
  subclasses: [], stats: [],
  perks: [{ hash: 1, name: "Frenzy", kind: "perk", description: "", tags: EMPTY_TAGS }],
  mods: [{ hash: 2, name: "Firepower", kind: "mod", energyCost: 3, tags: EMPTY_TAGS }],
  artifacts: [
    {
      hash: 9, name: "Artifact", kind: "artifact",
      tiers: [{ tierIndex: 0, slots: 2, perks: [{ hash: 3, name: "Anti-Barrier", tags: EMPTY_TAGS }] }],
    },
  ],
} as unknown as DerivedDataset;

describe("createLookup — perk/mod/artifactPerk", () => {
  const lookup = createLookup(dataset);

  it("resolves a perk by hash", () => {
    expect(lookup.perk(1)?.name).toBe("Frenzy");
  });
  it("resolves a mod by hash", () => {
    expect(lookup.mod(2)?.name).toBe("Firepower");
  });
  it("resolves a flattened artifact perk by hash", () => {
    expect(lookup.artifactPerk(3)?.name).toBe("Anti-Barrier");
  });
  it("returns undefined for unknown hashes", () => {
    expect(lookup.perk(999)).toBeUndefined();
    expect(lookup.mod(999)).toBeUndefined();
    expect(lookup.artifactPerk(999)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/validation/lookup.test.ts`
Expected: FAIL — `lookup.perk` is not a function (accessors don't exist yet).

- [ ] **Step 3: Extend the types**

In `src/lib/validation/types.ts`, add `Perk`, `Mod`, `ArtifactPerk` to the existing `@/lib/types` import. Add the two codes to the `ViolationCode` union (append before the closing of the union):

```ts
  | "UNUSED_PRODUCER"
  | "UNMET_CONSUMER"
```

Replace the `ViolationSubject` interface with:

```ts
export interface ViolationSubject {
  kind:
    | "subclass"
    | "aspect"
    | "fragment"
    | "weapon"
    | "armor"
    | "armorSet"
    | "artifact"
    | "synergy";
  hash?: Hash;
  slot?: string;
  /** Keyword a synergy advisory refers to (e.g. "volatile"). */
  keyword?: string;
}
```

Add to the `Lookup` interface (after `artifact(hash: Hash): Artifact | undefined;`):

```ts
  perk(hash: Hash): Perk | undefined;
  mod(hash: Hash): Mod | undefined;
  artifactPerk(hash: Hash): ArtifactPerk | undefined;
```

- [ ] **Step 4: Extend `createLookup`**

In `src/lib/validation/lookup.ts`, add `ArtifactPerk` to imports (`import type { ArtifactPerk, DerivedDataset, Hash } from "@/lib/types";`). Inside `createLookup`, after the existing index lines, add:

```ts
  const perks = indexByHash(dataset.perks);
  const mods = indexByHash(dataset.mods);
  const artifactPerks = new Map<Hash, ArtifactPerk>();
  for (const artifact of dataset.artifacts) {
    for (const tier of artifact.tiers) {
      for (const p of tier.perks) {
        if (!artifactPerks.has(p.hash)) artifactPerks.set(p.hash, p);
      }
    }
  }
```

And in the returned object, after `artifact: (hash) => artifacts.get(hash),`:

```ts
    perk: (hash) => perks.get(hash),
    mod: (hash) => mods.get(hash),
    artifactPerk: (hash) => artifactPerks.get(hash),
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm test tests/validation/lookup.test.ts && pnpm exec tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/validation/types.ts src/lib/validation/lookup.ts tests/validation/lookup.test.ts
git commit -m "Extend Lookup with perk/mod/artifactPerk + synergy violation vocabulary"
```

---

### Task 2: Synergy module types + build-element collection

**Files:**
- Create: `src/lib/synergy/types.ts`
- Modify: `src/lib/synergy/index.ts`
- Create: `src/lib/synergy/elements.ts`
- Test: `tests/synergy/elements.test.ts`

**Interfaces:**
- Consumes: `Build`, `Hash`, `Keyword`, `KeywordTags` from `@/lib/types`; `Lookup` from `@/lib/validation/types`.
- Produces: `Synergy`, `SynergyScore`, `BuildElement { hash: Hash; source: string; tags: KeywordTags }`, `OverlayEntry { fromHash: Hash; toHash: Hash; via: string; weight: number; why: string }` in `./types`; `collectBuildElements(build, lookup): BuildElement[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/synergy/elements.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { EMPTY_TAGS, type Build } from "@/lib/types";
import type { Lookup } from "@/lib/validation/types";
import { collectBuildElements } from "@/lib/synergy/elements";

const tags = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });

const base: Build = {
  subclass: { aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
};

// Minimal stub: only the accessors collectBuildElements uses need to resolve.
const lookup = {
  aspect: (h: number) => (h === 10 ? { hash: 10, name: "Asp", tags: tags({ produces: ["scorch"] }) } : undefined),
  fragment: (h: number) => (h === 11 ? { hash: 11, name: "Frag", tags: tags({ consumes: ["scorch"] }) } : undefined),
  weapon: (h: number) => (h === 12 ? { hash: 12, name: "Gun", tags: tags({ element: "void" }) } : undefined),
  perk: (h: number) => (h === 13 ? { hash: 13, name: "Frenzy", tags: tags({ produces: ["volatile"] }) } : undefined),
  armor: (h: number) => (h === 14 ? { hash: 14, name: "Exotic", tags: tags({ consumes: ["volatile"] }) } : undefined),
  mod: (h: number) => (h === 15 ? { hash: 15, name: "Mod", tags: tags({ triggers: ["grenade"] }) } : undefined),
  artifactPerk: (h: number) => (h === 16 ? { hash: 16, name: "AP", tags: tags({ produces: ["jolt"] }) } : undefined),
} as unknown as Lookup;

describe("collectBuildElements", () => {
  it("resolves every specified element with a source label", () => {
    const build: Build = {
      ...base,
      subclass: { aspectHashes: [10], fragmentHashes: [11] },
      weapons: [{ slot: "kinetic", itemHash: 12, perkConstraints: [{ perkHash: 13 }] }],
      armor: { ...base.armor, exoticHash: 14, modHashes: [15] },
      artifact: { artifactHash: 99, selectedPerkHashes: [16] },
    };
    const els = collectBuildElements(build, lookup);
    expect(els.map((e) => e.hash).sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 15, 16]);
    expect(els.find((e) => e.hash === 11)?.source).toBe("fragment:Frag");
  });

  it("skips name-only perk constraints and unresolved hashes", () => {
    const build: Build = {
      ...base,
      weapons: [{ slot: "kinetic", itemHash: 999, perkConstraints: [{ perkName: "Rampage" }] }],
    };
    expect(collectBuildElements(build, lookup)).toEqual([]);
  });

  it("is empty for an empty build", () => {
    expect(collectBuildElements(base, lookup)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/synergy/elements.test.ts`
Expected: FAIL — `@/lib/synergy/elements` does not exist.

- [ ] **Step 3: Create the synergy types module**

Create `src/lib/synergy/types.ts`:

```ts
import type { Hash, Keyword, KeywordTags } from "@/lib/types";

/**
 * A single detected synergy between two build elements — a producer→consumer
 * keyword chain, a trigger alignment, or a curated combo. Always carries a
 * human-readable `why` (non-negotiable for trust).
 */
export interface Synergy {
  fromHash: Hash;
  toHash: Hash;
  /** The keyword/trigger mediating the interaction (e.g. "volatile", "trigger:grenade"). */
  via: Keyword;
  /** Marginal contribution of this synergy to the total score. */
  weight: number;
  /** Human-readable explanation of the tag chain that fired. */
  why: string;
}

/** A synergy score with the reasons that produced it. `score === Σ weight`. */
export interface SynergyScore {
  score: number;
  synergies: Synergy[];
}

/** A build element resolved to its keyword tags, with a human-readable source. */
export interface BuildElement {
  hash: Hash;
  /** e.g. "fragment:Facet of Bravery" — drives the "why" text. */
  source: string;
  tags: KeywordTags;
}

/** A hand-authored synergy the keyword scan can't derive. Both endpoints required. */
export interface OverlayEntry {
  fromHash: Hash;
  toHash: Hash;
  via: string;
  weight: number;
  why: string;
}
```

- [ ] **Step 4: Move public types out of `index.ts`**

Replace the entire contents of `src/lib/synergy/index.ts` with (keeps the stubs inert until Task 4, but sourced from `./types`):

```ts
/**
 * Synergy engine seam. The solver reaches synergy ONLY through these exports.
 * Types live in ./types; the implementation is filled in across Phase 2 SP1.
 */

import type { Build } from "@/lib/types";

import type { Synergy, SynergyScore } from "./types";

export type { Synergy, SynergyScore } from "./types";

/** STUB (replaced in Task 4). */
export function getSynergies(_build: Build): Synergy[] {
  return [];
}

/** STUB (replaced in Task 4). */
export function scoreSynergy(_build: Build): SynergyScore {
  return { score: 0, synergies: [] };
}
```

- [ ] **Step 5: Implement `collectBuildElements`**

Create `src/lib/synergy/elements.ts`:

```ts
import type { Build, Hash, KeywordTags } from "@/lib/types";

import type { Lookup } from "@/lib/validation/types";

import type { BuildElement } from "./types";

/** Resolve a (partial) build into the tagged elements that drive synergy. */
export function collectBuildElements(build: Build, lookup: Lookup): BuildElement[] {
  const out: BuildElement[] = [];
  const add = (hash: Hash, source: string, tags: KeywordTags) => {
    out.push({ hash, source, tags });
  };

  for (const h of build.subclass.aspectHashes) {
    const a = lookup.aspect(h);
    if (a) add(a.hash, `aspect:${a.name}`, a.tags);
  }
  for (const h of build.subclass.fragmentHashes) {
    const f = lookup.fragment(h);
    if (f) add(f.hash, `fragment:${f.name}`, f.tags);
  }
  for (const w of build.weapons) {
    if (w.itemHash !== undefined) {
      const weapon = lookup.weapon(w.itemHash);
      if (weapon) add(weapon.hash, `weapon:${weapon.name}`, weapon.tags);
    }
    for (const c of w.perkConstraints) {
      if (c.perkHash === undefined) continue; // name-only constraints unresolved in v1
      const p = lookup.perk(c.perkHash);
      if (p) add(p.hash, `perk:${p.name}`, p.tags);
    }
  }
  if (build.armor.exoticHash !== undefined) {
    const ar = lookup.armor(build.armor.exoticHash);
    if (ar) add(ar.hash, `armor:${ar.name}`, ar.tags);
  }
  for (const h of build.armor.modHashes) {
    const m = lookup.mod(h);
    if (m) add(m.hash, `mod:${m.name}`, m.tags);
  }
  for (const h of build.artifact.selectedPerkHashes) {
    const ap = lookup.artifactPerk(h);
    if (ap) add(ap.hash, `artifact-perk:${ap.name}`, ap.tags);
  }
  return out;
}
```

- [ ] **Step 6: Run tests to verify pass**

Run: `pnpm test tests/synergy/elements.test.ts && pnpm exec tsc --noEmit && pnpm test`
Expected: all PASS (existing suite unaffected — stubs still typecheck); tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/synergy/types.ts src/lib/synergy/index.ts src/lib/synergy/elements.ts tests/synergy/elements.test.ts
git commit -m "Add synergy types + build-element collector"
```

---

### Task 3: Weights + producer→consumer graph

**Files:**
- Create: `src/lib/synergy/weights.ts`
- Create: `src/lib/synergy/graph.ts`
- Test: `tests/synergy/graph.test.ts`

**Interfaces:**
- Consumes: `SubclassElement` from `@/lib/types`; `BuildElement`, `Synergy`, `OverlayEntry` from `./types`.
- Produces: constants `CHAIN_BASE`, `ELEMENT_ALIGNED_MULT`, `TRIGGER_SHARE`, `TRIGGER_GROUP_CAP`, `CURATED_OVERLAY: OverlayEntry[]` in `./weights`; `matchChains(elements, subclassElement?): ChainResult` and `triggerSynergies(elements): Synergy[]` in `./graph`, where `ChainResult { synergies: Synergy[]; unusedProducers: string[]; unmetConsumers: string[] }`.

- [ ] **Step 1: Write the failing test**

Create `tests/synergy/graph.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { EMPTY_TAGS } from "@/lib/types";
import type { BuildElement } from "@/lib/synergy/types";
import { matchChains, triggerSynergies } from "@/lib/synergy/graph";

const el = (hash: number, over: Partial<typeof EMPTY_TAGS>): BuildElement => ({
  hash, source: `e:${hash}`, tags: { ...EMPTY_TAGS, ...over },
});

describe("matchChains", () => {
  it("weights successive chains in a keyword 1, 2, 3 (quadratic depth)", () => {
    const els = [
      el(1, { produces: ["volatile"] }),
      el(2, { produces: ["volatile"] }),
      el(3, { consumes: ["volatile"] }),
      el(4, { consumes: ["volatile"] }),
    ];
    const { synergies } = matchChains(els);
    expect(synergies.map((s) => s.weight).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("applies the element-alignment multiplier only when both ends align", () => {
    const els = [
      el(1, { produces: ["volatile"], element: "void" }),
      el(2, { consumes: ["volatile"], element: "void" }),
    ];
    expect(matchChains(els, "void").synergies[0].weight).toBe(1.5);
    expect(matchChains(els, "arc").synergies[0].weight).toBe(1);
    expect(matchChains(els).synergies[0].weight).toBe(1);
  });

  it("never pairs a produce+consume element with itself, nor flags it as a gap", () => {
    const els = [el(1, { produces: ["restoration"], consumes: ["restoration"] })];
    const r = matchChains(els);
    expect(r.synergies).toEqual([]);
    expect(r.unusedProducers).toEqual([]);
    expect(r.unmetConsumers).toEqual([]);
  });

  it("reports leftover producers/consumers as gaps", () => {
    const producerOnly = matchChains([el(1, { produces: ["jolt"] })]);
    expect(producerOnly.unusedProducers).toEqual(["jolt"]);
    expect(producerOnly.unmetConsumers).toEqual([]);
    const consumerOnly = matchChains([el(2, { consumes: ["jolt"] })]);
    expect(consumerOnly.unmetConsumers).toEqual(["jolt"]);
    expect(consumerOnly.unusedProducers).toEqual([]);
  });
});

describe("triggerSynergies", () => {
  it("caps pairs per trigger group at TRIGGER_GROUP_CAP", () => {
    const els = [1, 2, 3, 4].map((h) => el(h, { triggers: ["grenade"] }));
    const out = triggerSynergies(els); // C(4,2)=6 possible, capped at 3
    expect(out.length).toBe(3);
    expect(out.every((s) => s.via === "trigger:grenade" && s.weight === 0.5)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/synergy/graph.test.ts`
Expected: FAIL — `@/lib/synergy/graph` does not exist.

- [ ] **Step 3: Create the weights module**

Create `src/lib/synergy/weights.ts`:

```ts
import type { OverlayEntry } from "./types";

/** Base weight of the first matched producer→consumer chain in a keyword. */
export const CHAIN_BASE = 1.0;
/** Multiplier when both ends of a chain align with the build's subclass element. */
export const ELEMENT_ALIGNED_MULT = 1.5;
/** Weight of one trigger-alignment pair. */
export const TRIGGER_SHARE = 0.5;
/** Max trigger-alignment pairs contributed per trigger group. */
export const TRIGGER_GROUP_CAP = 3;

/**
 * Hand-authored synergies the keyword scan can't derive. Empty in v1 — an
 * inline, type-checked array so entries are validated at compile time. Authoring
 * real entries is ongoing work outside this sub-project.
 */
export const CURATED_OVERLAY: OverlayEntry[] = [];
```

- [ ] **Step 4: Implement the graph**

Create `src/lib/synergy/graph.ts`:

```ts
import type { SubclassElement } from "@/lib/types";

import type { BuildElement, Synergy } from "./types";
import {
  CHAIN_BASE,
  ELEMENT_ALIGNED_MULT,
  TRIGGER_GROUP_CAP,
  TRIGGER_SHARE,
} from "./weights";

export interface ChainResult {
  synergies: Synergy[];
  /** Keywords with at least one producer left unpaired (and not self-satisfied). */
  unusedProducers: string[];
  /** Keywords with at least one consumer left unpaired (and not self-satisfied). */
  unmetConsumers: string[];
}

const byHash = (a: BuildElement, b: BuildElement) => a.hash - b.hash;

function aligned(el: BuildElement, subclassElement?: SubclassElement): boolean {
  return (
    subclassElement !== undefined &&
    (el.tags.element === subclassElement || el.tags.element === "prismatic")
  );
}

/** Match producer→consumer chains per keyword with escalating (1,2,3,…) weights. */
export function matchChains(
  elements: BuildElement[],
  subclassElement?: SubclassElement,
): ChainResult {
  const synergies: Synergy[] = [];
  const unusedProducers: string[] = [];
  const unmetConsumers: string[] = [];

  const keywords = new Set<string>();
  for (const el of elements) {
    for (const k of el.tags.produces) keywords.add(k);
    for (const k of el.tags.consumes) keywords.add(k);
  }

  for (const K of [...keywords].sort()) {
    const producers = elements.filter((e) => e.tags.produces.includes(K)).sort(byHash);
    const consumers = elements.filter((e) => e.tags.consumes.includes(K)).sort(byHash);
    const usedConsumer = new Set<BuildElement>();
    const matchedProducer = new Set<BuildElement>();
    let rank = 0;

    for (const p of producers) {
      const c = consumers.find((cand) => cand !== p && !usedConsumer.has(cand));
      if (!c) continue;
      usedConsumer.add(c);
      matchedProducer.add(p);
      rank += 1;
      let weight = CHAIN_BASE * rank;
      if (aligned(p, subclassElement) && aligned(c, subclassElement)) {
        weight *= ELEMENT_ALIGNED_MULT;
      }
      const suffix = rank > 1 ? ` (link #${rank}, ×${rank})` : "";
      synergies.push({
        fromHash: p.hash,
        toHash: c.hash,
        via: K,
        weight,
        why: `${p.source} creates ${K} → ${c.source} benefits from ${K}${suffix}`,
      });
    }

    // Leftovers: a produce+consume element self-satisfies, so it isn't a gap.
    if (producers.some((p) => !matchedProducer.has(p) && !p.tags.consumes.includes(K))) {
      unusedProducers.push(K);
    }
    if (consumers.some((c) => !usedConsumer.has(c) && !c.tags.produces.includes(K))) {
      unmetConsumers.push(K);
    }
  }

  return { synergies, unusedProducers, unmetConsumers };
}

/** Lower-weight synergies for elements sharing a trigger, capped per group. */
export function triggerSynergies(elements: BuildElement[]): Synergy[] {
  const byTrigger = new Map<string, BuildElement[]>();
  for (const el of elements) {
    for (const t of el.tags.triggers) {
      byTrigger.set(t, [...(byTrigger.get(t) ?? []), el]);
    }
  }

  const out: Synergy[] = [];
  for (const t of [...byTrigger.keys()].sort()) {
    const group = [...(byTrigger.get(t) ?? [])].sort(byHash);
    let count = 0;
    for (let i = 0; i < group.length && count < TRIGGER_GROUP_CAP; i++) {
      for (let j = i + 1; j < group.length && count < TRIGGER_GROUP_CAP; j++) {
        out.push({
          fromHash: group[i].hash,
          toHash: group[j].hash,
          via: `trigger:${t}`,
          weight: TRIGGER_SHARE,
          why: `${group[i].source} and ${group[j].source} both trigger on ${t}`,
        });
        count += 1;
      }
    }
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm test tests/synergy/graph.test.ts && pnpm exec tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/synergy/weights.ts src/lib/synergy/graph.ts tests/synergy/graph.test.ts
git commit -m "Add synergy weights + producer→consumer graph"
```

---

### Task 4: Scoring + public seam wiring

**Files:**
- Create: `src/lib/synergy/score.ts`
- Modify: `src/lib/synergy/index.ts`
- Test: `tests/synergy/score.test.ts`

**Interfaces:**
- Consumes: `Build` from `@/lib/types`; `Lookup` from `@/lib/validation/types`; `collectBuildElements` from `./elements`; `matchChains`, `triggerSynergies` from `./graph`; `CURATED_OVERLAY` from `./weights`; `BuildElement`, `Synergy`, `SynergyScore`, `OverlayEntry` from `./types`.
- Produces: `getSynergies(build, lookup): Synergy[]`, `scoreSynergy(build, lookup): SynergyScore`, `overlaySynergies(elements, entries?): Synergy[]` in `./score`; re-exported from `./index` (replacing the stubs).

- [ ] **Step 1: Write the failing test**

Create `tests/synergy/score.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { EMPTY_TAGS, type Build } from "@/lib/types";
import type { Lookup } from "@/lib/validation/types";
import type { OverlayEntry } from "@/lib/synergy/types";
import { getSynergies, overlaySynergies, scoreSynergy } from "@/lib/synergy/score";

const tags = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });

const base: Build = {
  subclass: { element: "void", aspectHashes: [10], fragmentHashes: [11] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
};

const lookup = {
  aspect: (h: number) => (h === 10 ? { hash: 10, name: "Producer", tags: tags({ produces: ["volatile"], element: "void" }) } : undefined),
  fragment: (h: number) => (h === 11 ? { hash: 11, name: "Consumer", tags: tags({ consumes: ["volatile"], element: "void" }) } : undefined),
} as unknown as Lookup;

describe("scoreSynergy", () => {
  it("score equals the sum of synergy weights (invariant)", () => {
    const result = scoreSynergy(base, lookup);
    const summed = result.synergies.reduce((s, x) => s + x.weight, 0);
    expect(result.score).toBe(summed);
    expect(result.score).toBeGreaterThan(0); // one element-aligned volatile chain
  });

  it("returns a zero score with no synergies for an empty build", () => {
    const empty: Build = { ...base, subclass: { aspectHashes: [], fragmentHashes: [] } };
    expect(scoreSynergy(empty, lookup)).toEqual({ score: 0, synergies: [] });
  });
});

describe("getSynergies + overlaySynergies", () => {
  it("returns chains for a resolved build", () => {
    expect(getSynergies(base, lookup).length).toBeGreaterThan(0);
  });

  it("adds a curated entry only when both endpoints are present", () => {
    const entry: OverlayEntry = { fromHash: 10, toHash: 11, via: "curated", weight: 5, why: "known combo" };
    const present = overlaySynergies([{ hash: 10, source: "a", tags: EMPTY_TAGS }, { hash: 11, source: "b", tags: EMPTY_TAGS }], [entry]);
    expect(present).toHaveLength(1);
    const absent = overlaySynergies([{ hash: 10, source: "a", tags: EMPTY_TAGS }], [entry]);
    expect(absent).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/synergy/score.test.ts`
Expected: FAIL — `@/lib/synergy/score` does not exist.

- [ ] **Step 3: Implement scoring**

Create `src/lib/synergy/score.ts`:

```ts
import type { Build } from "@/lib/types";

import type { Lookup } from "@/lib/validation/types";

import { collectBuildElements } from "./elements";
import { matchChains, triggerSynergies } from "./graph";
import type { BuildElement, OverlayEntry, Synergy, SynergyScore } from "./types";
import { CURATED_OVERLAY } from "./weights";

/** Curated overlay entries whose both endpoints are present in the build. */
export function overlaySynergies(
  elements: BuildElement[],
  entries: OverlayEntry[] = CURATED_OVERLAY,
): Synergy[] {
  const present = new Set(elements.map((e) => e.hash));
  return entries
    .filter((o) => present.has(o.fromHash) && present.has(o.toHash))
    .map((o) => ({ fromHash: o.fromHash, toHash: o.toHash, via: o.via, weight: o.weight, why: o.why }));
}

/** Enumerate all synergies present in a build. */
export function getSynergies(build: Build, lookup: Lookup): Synergy[] {
  const elements = collectBuildElements(build, lookup);
  const chains = matchChains(elements, build.subclass.element);
  return [...chains.synergies, ...triggerSynergies(elements), ...overlaySynergies(elements)];
}

/** Score a build's synergy. `score === Σ synergy weight`. */
export function scoreSynergy(build: Build, lookup: Lookup): SynergyScore {
  const synergies = getSynergies(build, lookup);
  const score = synergies.reduce((sum, s) => sum + s.weight, 0);
  return { score, synergies };
}
```

- [ ] **Step 4: Wire the public seam**

Replace the stub functions in `src/lib/synergy/index.ts` so the file reads:

```ts
/**
 * Synergy engine seam. The solver reaches synergy ONLY through these exports;
 * it never knows whether rules, a curated overlay, or (Phase 3) embeddings sit
 * underneath. Types live in ./types.
 */

export type { BuildElement, OverlayEntry, Synergy, SynergyScore } from "./types";
export { getSynergies, scoreSynergy } from "./score";
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm test tests/synergy/score.test.ts && pnpm exec tsc --noEmit && pnpm test`
Expected: all PASS (full suite green); tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/synergy/score.ts src/lib/synergy/index.ts tests/synergy/score.test.ts
git commit -m "Implement synergy scoring + wire public seam"
```

---

### Task 5: Policy advisories + combined rule set

**Files:**
- Create: `src/lib/synergy/rules.ts`
- Modify: `src/lib/synergy/index.ts`
- Test: `tests/synergy/rules.test.ts`

**Interfaces:**
- Consumes: `Rule`, `Violation` from `@/lib/validation/types`; `ALL_RULES` from `@/lib/validation`; `collectBuildElements` from `./elements`; `matchChains` from `./graph`.
- Produces: `synergyRules: Rule[]` in `./rules`; `allRules: Rule[]` (= `[...ALL_RULES, ...synergyRules]`) re-exported from `./index`.

- [ ] **Step 1: Write the failing test**

Create `tests/synergy/rules.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { EMPTY_TAGS, type Build } from "@/lib/types";
import { validateBuild } from "@/lib/validation";
import type { Lookup } from "@/lib/validation/types";
import { synergyRules } from "@/lib/synergy/rules";

const tags = (over: Partial<typeof EMPTY_TAGS>) => ({ ...EMPTY_TAGS, ...over });

const base: Build = {
  subclass: { aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
};

const lookup = {
  aspect: (h: number) =>
    h === 1 ? { hash: 1, name: "Maker", tags: tags({ produces: ["volatile"] }) }
    : h === 2 ? { hash: 2, name: "User", tags: tags({ consumes: ["jolt"] }) }
    : undefined,
} as unknown as Lookup;

function codes(build: Build): string[] {
  return validateBuild(build, lookup, synergyRules).violations.map((v) => v.code);
}

describe("synergyRules (policy advisories)", () => {
  it("flags an unused producer without invalidating the build", () => {
    const build = { ...base, subclass: { aspectHashes: [1], fragmentHashes: [] } };
    const result = validateBuild(build, lookup, synergyRules);
    expect(result.violations.map((v) => v.code)).toContain("UNUSED_PRODUCER");
    expect(result.violations.every((v) => v.category === "policy")).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("flags an unmet consumer", () => {
    const build = { ...base, subclass: { aspectHashes: [2], fragmentHashes: [] } };
    expect(codes(build)).toContain("UNMET_CONSUMER");
  });

  it("is silent on an empty build", () => {
    expect(codes(base)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test tests/synergy/rules.test.ts`
Expected: FAIL — `@/lib/synergy/rules` does not exist.

- [ ] **Step 3: Implement the advisories**

Create `src/lib/synergy/rules.ts`:

```ts
import type { Rule, Violation } from "@/lib/validation/types";

import { collectBuildElements } from "./elements";
import { matchChains } from "./graph";

/** Soft `policy` advisories: unused producers and unmet consumers. */
const synergyAdvisories: Rule = (build, lookup) => {
  const elements = collectBuildElements(build, lookup);
  const { unusedProducers, unmetConsumers } = matchChains(elements, build.subclass.element);
  const out: Violation[] = [];

  for (const keyword of unusedProducers) {
    out.push({
      code: "UNUSED_PRODUCER",
      category: "policy",
      message: `You create ${keyword} but nothing in the build consumes it.`,
      subject: { kind: "synergy", keyword },
    });
  }
  for (const keyword of unmetConsumers) {
    out.push({
      code: "UNMET_CONSUMER",
      category: "policy",
      message: `You rely on ${keyword} but nothing in the build produces it.`,
      subject: { kind: "synergy", keyword },
    });
  }
  return out;
};

export const synergyRules: Rule[] = [synergyAdvisories];
```

- [ ] **Step 4: Export the combined rule set**

Append to `src/lib/synergy/index.ts`:

```ts
import type { Rule } from "@/lib/validation/types";
import { ALL_RULES } from "@/lib/validation";

import { synergyRules } from "./rules";

export { synergyRules } from "./rules";

/** Hard game rules + soft synergy advisories, for callers wanting both. */
export const allRules: Rule[] = [...ALL_RULES, ...synergyRules];
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm test tests/synergy/rules.test.ts && pnpm exec tsc --noEmit && pnpm exec eslint scripts src tests && pnpm test`
Expected: all PASS; tsc clean; eslint clean (0 errors).

- [ ] **Step 6: Commit**

```bash
git add src/lib/synergy/rules.ts src/lib/synergy/index.ts tests/synergy/rules.test.ts
git commit -m "Add synergy policy advisories + combined rule set"
```

---

### Task 6: Real-dataset integration test

**Files:**
- Test: `tests/synergy/integration.test.ts`

**Interfaces:**
- Consumes: `loadDataset` from `@/lib/data`; `createLookup`, `validateBuild` from `@/lib/validation`; `scoreSynergy`, `allRules` from `@/lib/synergy`; `Build`, `DerivedDataset` from `@/lib/types`.

- [ ] **Step 1: Write the integration test**

Create `tests/synergy/integration.test.ts`:

```ts
import { existsSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import type { Build, DerivedDataset, Fragment } from "@/lib/types";
import { createLookup, validateBuild, type Lookup } from "@/lib/validation";
import { allRules, scoreSynergy } from "@/lib/synergy";

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));

const emptyBuild = (): Build => ({
  subclass: { aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
});

describe.runIf(hasDataset)("synergy engine (integration)", () => {
  let ds: DerivedDataset;
  let lookup: Lookup;

  beforeAll(async () => {
    ds = await loadDataset();
    lookup = createLookup(ds);
  });

  it("scores a real producer→consumer fragment pair above zero with a why", () => {
    // Find any keyword one fragment produces and a DIFFERENT fragment consumes.
    let found: { p: Fragment; c: Fragment; kw: string } | undefined;
    for (const p of ds.fragments) {
      for (const kw of p.tags.produces) {
        const c = ds.fragments.find(
          (f) => f.hash !== p.hash && f.tags.consumes.includes(kw),
        );
        if (c) {
          found = { p, c, kw };
          break;
        }
      }
      if (found) break;
    }
    expect(found, "expected a producer/consumer fragment pair in the dataset").toBeTruthy();

    const build: Build = {
      ...emptyBuild(),
      subclass: {
        element: found!.p.tags.element,
        aspectHashes: [],
        fragmentHashes: [found!.p.hash, found!.c.hash],
      },
    };
    const result = scoreSynergy(build, lookup);
    expect(result.score).toBeGreaterThan(0);
    expect(result.synergies.some((s) => s.via === found!.kw)).toBe(true);
    expect(result.synergies[0].why.length).toBeGreaterThan(0);
  });

  it("emits an unused-producer advisory without invalidating", () => {
    // A fragment that produces a keyword it does NOT itself consume (so it is
    // not self-satisfied) — with nothing else in the build, that keyword is a gap.
    const pureProducer = ds.fragments.find((f) =>
      f.tags.produces.some((k) => !f.tags.consumes.includes(k)),
    );
    expect(pureProducer, "expected a non-self-consuming producer fragment").toBeTruthy();
    const build: Build = {
      ...emptyBuild(),
      subclass: { aspectHashes: [], fragmentHashes: [pureProducer!.hash] },
    };
    const result = validateBuild(build, lookup, allRules);
    expect(result.valid).toBe(true); // policy advisories never invalidate
    expect(result.violations.some((v) => v.code === "UNUSED_PRODUCER")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it runs and passes**

Run: `pnpm test tests/synergy/integration.test.ts`
Expected: the `describe.runIf(hasDataset)` block RUNS (dataset present) and both tests PASS.

- [ ] **Step 3: Full verification**

Run: `pnpm exec tsc --noEmit && pnpm exec eslint scripts src tests && pnpm test`
Expected: tsc exit 0; eslint 0 errors; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/synergy/integration.test.ts
git commit -m "Add synergy engine real-dataset integration test"
```

---

## Self-Review

**Spec coverage:**
- §2 Signal 1 (escalating chains, quadratic depth) → Task 3 `matchChains`. ✓
- §2 Signal 2 (element-alignment multiplier, prismatic-any, unset→no mult) → Task 3 `aligned`. ✓
- §2 Signal 3 (trigger alignment, capped) → Task 3 `triggerSynergies`. ✓
- §2 Signal 4 (curated overlay, both endpoints required, empty v1) → Tasks 3 (`CURATED_OVERLAY`) + 4 (`overlaySynergies`). ✓
- §2 invariant (`score == Σ weights`) → Task 4 test. ✓
- §3 advisories (`UNUSED_PRODUCER`/`UNMET_CONSUMER`, policy, from same matching, partial-safe, self-satisfied excluded) → Tasks 1 (codes) + 3 (leftovers) + 5 (rules). ✓
- §4 Lookup extension (`perk`/`mod`/`artifactPerk`) + signature change → Tasks 1 + 4. ✓
- §4 `collectBuildElements`, participating elements, name-only skip, self-pair-safe → Task 2. ✓
- §4 module layout + layering + `allRules` → Tasks 2–5. ✓
- §5 testing (unit + real-dataset integration) → Tasks 1–6. ✓

**Placeholder scan:** No TBD/TODO; every code step contains complete code. ✓

**Type consistency:** `Lookup` accessors (`perk`/`mod`/`artifactPerk`), `BuildElement { hash, source, tags }`, `ChainResult { synergies, unusedProducers, unmetConsumers }`, `matchChains(elements, subclassElement?)`, `getSynergies(build, lookup)` / `scoreSynergy(build, lookup)`, `overlaySynergies(elements, entries?)`, `synergyRules`/`allRules` used identically across tasks. Violation codes/subject match Task 1's additions. ✓

**Deviations from spec (intentional, noted):** curated overlay is an inline typed array rather than a JSON file (compile-time-checked, avoids `resolveJsonModule` config); overlay entries require both `fromHash` and `toHash` (Synergy needs both, and v1 overlay is empty). Advisory "self-satisfied" refinement: a produce+consume element left unpaired is not flagged as a gap (implements the spec's self-pair-safe intent for §3).
