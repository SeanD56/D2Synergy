/**
 * Data-contract assertions for the slice-2a signals.
 *
 * Unlike the smoke tests (which assert "> 0"), these hold measured FLOORS: if a
 * future re-ingest silently stops extracting exotic traits, mod slots, plug tags,
 * or champion coverage, this fails loudly. Floors sit below the measured values so
 * ordinary season drift does not trip them; a floor breach means the extraction
 * broke, not that the game changed.
 *
 * This file exists because of how slice 2a's own blocker hid: the exotic extraction
 * shipped, passed review, and emitted 0/348 — with a green suite, because nothing
 * asserted a floor against real data.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import type { DerivedDataset, KeywordTags } from "@/lib/types";

const hasDataset = existsSync(path.join(process.cwd(), "data", "dataset-meta.json"));

// Floors recorded in docs/superpowers/specs/2026-07-24-phase2-sp3b-slice2a-dataset-signals-design.md
// (manifest 244213.26.06.29.2000-1-bnet.65583). Measured values in brackets.
const FLOOR_EXOTIC_TAG_RATIO = 0.65; // [measured 0.761 — 265/348]
const FLOOR_EXOTIC_PERK_HASH_RATIO = 0.9; // [measured 0.974 — 339/348]
// Re-pinned after inert mod plugs were excluded at ingest: the mod population fell 512 -> 451
// (64 placeholder/no-effect entries removed), so the absolute count of slot-restricted mods fell
// 316 -> 279 while the RATIO rose (316/512 = 62% -> 279/451 = 62%, essentially unchanged — the
// removed entries were spread across both groups). A floor breach means extraction broke, not
// that the game changed.
const FLOOR_MODS_WITH_SLOT = 250; // ~62% of 451 [measured 279]
const FLOOR_TAGGED_PLUGS = 200; // [measured 280]
const FLOOR_CHAMPION_ENTITIES = 120; // [measured 188]

/** The champion-stun ids, which must never appear as producer/consumer keywords. */
const CHAMPION_KEYWORDS = new Set(["barrier", "overload", "unstoppable"]);

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

  it("tags a floor share of exotic armor from its trait plug", () => {
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

  it("never sets exoticPerkHash on non-exotic armor", () => {
    // The `tier === "exotic"` guard lives on the trait-plug lookup, not the field itself.
    const leaked = ds.armor.filter((a) => a.tier !== "exotic" && a.exoticPerkHash !== undefined);
    expect(leaked.map((a) => a.name)).toEqual([]);
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

  it("does not inline tags onto weapon plugs (they belong in the side table)", () => {
    // Guards the 7.08MB-vs-0.08MB decision: WeaponPerk carries hash + name only.
    const plug = ds.weapons.flatMap((w) => w.perkColumns.flatMap((c) => c.plugs))[0];
    expect(plug).toBeDefined();
    expect(Object.keys(plug).sort()).toEqual(["hash", "name"]);
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
    // Checked across EVERY tagged entity, not just mods: champion coverage actually lives in
    // sandbox perks (176) and artifact perks (12) — mods carry none, so checking mods alone
    // would guard the one source with no champion data.
    const tagged: Array<{ name: string; tags: KeywordTags }> = [
      ...ds.mods, ...ds.armor, ...ds.weapons, ...ds.aspects, ...ds.fragments, ...ds.perks,
      ...ds.artifacts.flatMap((a) => a.tiers.flatMap((t) => t.perks)),
      ...Object.entries(ds.plugTags).map(([hash, tags]) => ({ name: `plug:${hash}`, tags })),
    ];
    const leaked = tagged.filter((e) =>
      e.tags.produces.some((k) => CHAMPION_KEYWORDS.has(k)) ||
      e.tags.consumes.some((k) => CHAMPION_KEYWORDS.has(k)));
    expect(leaked.map((e) => e.name)).toEqual([]);
  });

  it("holds the artifact structure SP2's capacity oracle assumes", () => {
    for (const artifact of ds.artifacts) {
      expect(artifact.tiers, artifact.name).toHaveLength(3);
      expect(artifact.tiers.reduce((sum, t) => sum + t.slots, 0), artifact.name).toBe(7);
    }
  });
});

describe.runIf(hasDataset)("dataset contract — curated spot-checks", () => {
  let ds: DerivedDataset;

  beforeAll(async () => {
    ds = await loadDataset();
  });

  // [exotic armor name, bucket, keyword] — all verified present in the measured dataset.
  // Deliberately spans five elemental subsystems so one element's extraction breaking is
  // still caught, and no single retired exotic can take the whole gate down.
  const CURATED_EXOTICS: Array<[string, "produces" | "consumes" | "triggers", string]> = [
    ["Swarmers", "produces", "tangle"], // strand
    ["Helm of Saint-14", "produces", "suppress"], // void
    ["Geomag Stabilizers", "produces", "ionic_trace"], // arc
    ["Mask of Fealty", "produces", "freeze"], // stasis
    ["Promethium Spur", "produces", "radiant"], // solar
    ["Necrotic Grip", "produces", "devour"], // void, poison/devour path
  ];

  for (const [name, bucket, keyword] of CURATED_EXOTICS) {
    it(`${name} resolves to ${bucket}:${keyword}`, () => {
      const piece = ds.armor.find((a) => a.name === name && a.tier === "exotic");
      expect(piece, `${name} must be present`).toBeDefined();
      expect(piece!.tags[bucket]).toContain(keyword);
    });
  }

  it("an artifact perk carries championStuns from its name/description", () => {
    // NOTE: the plan specified an "anti-barrier" artifact perk here, but this manifest has
    // NONE (0 perks match /anti-barrier/). "Overload Grenades" is the measured equivalent —
    // 12 artifact perks carry championStuns, all currently "unstoppable" or "overload".
    const perks = ds.artifacts.flatMap((a) => a.tiers.flatMap((t) => t.perks));
    const overload = perks.filter((p) => p.name === "Overload Grenades");
    expect(overload.length, "Overload Grenades must be present").toBeGreaterThan(0);
    expect(overload.some((p) => p.tags.championStuns?.includes("overload"))).toBe(true);
  });

  it("champion extraction reaches artifact perks, not just sandbox perks", () => {
    const perks = ds.artifacts.flatMap((a) => a.tiers.flatMap((t) => t.perks));
    expect(perks.filter((p) => (p.tags.championStuns?.length ?? 0) > 0).length)
      .toBeGreaterThan(0);
  });
});

/**
 * Subclass-plug coverage floors — the repair that gave the dataset Stasis and removed the
 * "Empty … Socket" placeholders.
 *
 * These exist because the previous shape was green and wrong in a way nothing caught:
 * `SubclassElement` admits "stasis", but `plugKind` matched only "aspects"/"fragments"
 * while the manifest files Stasis aspects under `*.stasis.totems` and Stasis fragments
 * under `shared.stasis.trinkets`. So every Stasis build resolved to an EMPTY aspect and
 * fragment pool — reported as an ordinary `feasible: false`, indistinguishable from a
 * genuinely over-constrained build. Meanwhile 18 of 81 aspects and 12 of 95 fragments
 * were placeholder sockets the solver could "choose".
 *
 * Measured on manifest 244213.26.06.29.2000-1-bnet.65583: 75 aspects (25 per class, 4 per
 * class+element and 5 for prismatic), 99 fragments, zero placeholders.
 */
describe.runIf(hasDataset)("dataset contract — subclass plug coverage", () => {
  let ds: DerivedDataset;
  beforeAll(async () => { ds = await loadDataset(); });

  /** Every element a build may pin. Each must have BOTH aspects and fragments to complete. */
  const SUBCLASS_ELEMENTS = ["arc", "solar", "void", "stasis", "strand", "prismatic"] as const;

  it.each(SUBCLASS_ELEMENTS)("has aspects for every class on %s", (element) => {
    for (const classType of ["hunter", "titan", "warlock"] as const) {
      const pool = ds.aspects.filter(
        (a) => a.element === element && (a.classType === classType || a.classType === "any"),
      );
      // >= 2 because the game floor is exactly two aspects: a pool of 1 cannot complete.
      expect(pool.length, `${classType}/${element} aspect pool`).toBeGreaterThanOrEqual(2);
    }
  });

  it.each(SUBCLASS_ELEMENTS)("has fragments for %s", (element) => {
    expect(ds.fragments.filter((f) => f.element === element).length).toBeGreaterThanOrEqual(8);
  });

  it("carries a real Guardian class on every aspect — never the 'any' fallback", () => {
    // `item.classType` is Unknown(3) on all aspect plugs, so this passes only while the
    // identifier-prefix parse works. If it regresses, all 75 collapse back to "any" and a
    // solver-chosen-aspect dimension would offer Warlock aspects to a Titan.
    expect(ds.aspects.filter((a) => a.classType === "any")).toEqual([]);
    for (const classType of ["hunter", "titan", "warlock"] as const) {
      expect(ds.aspects.filter((a) => a.classType === classType).length)
        .toBeGreaterThanOrEqual(20);
    }
  });

  it("excludes inert placeholder plugs from MODS too", () => {
    // Extends the aspect/fragment guarantee to mods, once the discriminator was measured against
    // that population. Without this the solver could "choose" an Empty Mod Socket.
    const inertNamed = ds.mods.filter((m) => /^(Empty .* Socket|Locked .*)$/.test(m.name));
    expect(inertNamed).toEqual([]);
    expect(ds.mods.filter((m) => !m.name)).toEqual([]); // no nameless stubs either
    expect(ds.mods.length).toBeGreaterThanOrEqual(400); // [measured 451] — anti-over-exclusion
  });

  it("excludes placeholder Empty-Socket plugs from aspects and fragments", () => {
    const placeholders = [...ds.aspects, ...ds.fragments].filter((x) => /^Empty .* Socket$/.test(x.name));
    expect(placeholders).toEqual([]);
    // Structural corollary: a real aspect always grants fragment slots. This is the
    // discriminator's own invariant, asserted independently of the name test above.
    expect(ds.aspects.filter((a) => a.fragmentSlots === 0)).toEqual([]);
  });

  it("keeps the measured entity floors", () => {
    expect(ds.aspects.length).toBeGreaterThanOrEqual(70); // [measured 75]
    expect(ds.fragments.length).toBeGreaterThanOrEqual(90); // [measured 99]
  });
});

/**
 * Socket-type side table — the mod capacity oracle's prerequisite (SP3b slice 2c).
 *
 * The handoff twice deferred the mods slice on the belief that the manifest might not carry
 * socket-type → accepted-plug-category data. It does, and `DestinySocketTypeDefinition` was
 * already being fetched. These floors keep that true: if a future ingest stops resolving
 * armour socket types, the oracle would silently start believing no mod fits anywhere.
 *
 * Measured on manifest 244213.26.06.29.2000-1-bnet.65583: 279 socket types, and 100% of the
 * 25,828 `modSocketHashes` references across armour resolve in the table.
 */
describe.runIf(hasDataset)("dataset contract — armour socket types", () => {
  let ds: DerivedDataset;
  beforeAll(async () => { ds = await loadDataset(); });

  it("emits a socket-type table at the measured floor", () => {
    expect(Object.keys(ds.socketTypes).length).toBeGreaterThanOrEqual(250); // [measured 279]
  });

  it("never emits an empty category list", () => {
    // Empty would read as "this socket accepts nothing" — a different and much more
    // destructive claim than "unknown socket type", which is encoded as absence.
    const empty = Object.entries(ds.socketTypes).filter(([, cats]) => cats.length === 0);
    expect(empty).toEqual([]);
  });

  it("resolves EVERY socket type that armour actually references", () => {
    // THE oracle prerequisite: an unresolvable socket is a socket whose legality cannot be
    // decided, so partial coverage here is not a partial feature — it is a wrong answer.
    const missing = new Set<number>();
    let total = 0;
    for (const piece of ds.armor) {
      for (const h of piece.modSocketHashes ?? []) {
        total++;
        if (!ds.socketTypes[h]) missing.add(h);
      }
    }
    expect(total).toBeGreaterThan(20_000); // [measured 25,828] — guards against a vacuous pass
    expect([...missing]).toEqual([]);
  });

  it("covers each per-slot armour mod category", () => {
    const accepted = new Set(Object.values(ds.socketTypes).flat());
    for (const category of [
      "enhancements.v2_head", "enhancements.v2_arms", "enhancements.v2_chest",
      "enhancements.v2_legs", "enhancements.v2_class_item", "enhancements.v2_general",
    ]) {
      expect(accepted.has(category), `no armour socket accepts ${category}`).toBe(true);
    }
  });

  it("keeps most mod categories socket-addressable, with the Ghost-mod remainder", () => {
    const accepted = new Set(Object.values(ds.socketTypes).flat());
    const modCategories = new Set(ds.mods.map((m) => m.plugCategory).filter(Boolean));
    const addressable = [...modCategories].filter((c) => accepted.has(c!));
    expect(addressable.length).toBeGreaterThanOrEqual(25); // [measured 29 of 35]
    // The remainder is Ghost-shell mods, which is ALSO the standing explanation for the 196
    // mods that keep `slotRestriction: undefined` (see the slice-2a section of the handoff).
    const orphans = [...modCategories].filter((c) => !accepted.has(c!));
    for (const o of orphans) {
      expect(o, `unexpected non-Ghost orphan category ${o}`).toMatch(/ghosts_|season_opulence/);
    }
  });
});
