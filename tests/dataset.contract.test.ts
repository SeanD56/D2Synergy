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
const FLOOR_MODS_WITH_SLOT = 280; // ~55% of 512 [measured 316]
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
