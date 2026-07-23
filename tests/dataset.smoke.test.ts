/**
 * Smoke assertions over the emitted derived dataset (Phase 0 verification).
 *
 * Skips entirely when `data/` hasn't been ingested yet (so `pnpm test` is green
 * on a fresh checkout); run `pnpm ingest` first to exercise them. Several
 * assertions double as checks on the design's "flagged unknowns" — if one
 * fails, the transform needs adjusting against the live Manifest, not the test.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { loadDataset } from "@/lib/data";
import type { DerivedDataset } from "@/lib/types";

const hasDataset = existsSync(
  path.join(process.cwd(), "data", "dataset-meta.json"),
);

describe.runIf(hasDataset)("derived dataset", () => {
  let ds: DerivedDataset;

  beforeAll(async () => {
    ds = await loadDataset();
  });

  it("records manifest provenance and entity counts", () => {
    expect(ds.meta.manifestVersion).toBeTruthy();
    expect(ds.meta.ingestedAt).toBeTruthy();
    expect(Object.keys(ds.meta.counts).length).toBeGreaterThan(0);
  });

  it("has weapons with column-structured, non-empty perk pools", () => {
    expect(ds.weapons.length).toBeGreaterThan(0);
    // At least one weapon should expose a randomized column with real choices.
    const withRolls = ds.weapons.find((w) =>
      w.perkColumns.some((col) => col.plugs.length >= 2),
    );
    expect(withRolls, "no weapon has a multi-plug perk column").toBeDefined();
    // Columns are keyed by socket index so co-occurrence is answerable.
    for (const column of withRolls!.perkColumns) {
      expect(typeof column.socketIndex).toBe("number");
      expect(column.plugs.every((p) => p.name.length > 0)).toBe(true);
    }
  });

  it("has aspects that grant fragment slots (flagged unknown #1)", () => {
    expect(ds.aspects.length).toBeGreaterThan(0);
    expect(
      ds.aspects.some((a) => a.fragmentSlots > 0),
      "no aspect reports fragmentSlots > 0 — verify the fragment-slot stat hash",
    ).toBe(true);
  });

  it("has fragments carrying stat modifiers", () => {
    expect(ds.fragments.length).toBeGreaterThan(0);
    expect(ds.fragments.some((f) => f.statModifiers.length > 0)).toBe(true);
  });

  it("exposes 2pc and 4pc armor-set bonuses resolving to real perk text", () => {
    expect(ds.armorSets.length).toBeGreaterThan(0);
    const bonuses = ds.armorSets.flatMap((s) => s.bonuses);
    const two = bonuses.find((b) => b.requiredCount === 2);
    const four = bonuses.find((b) => b.requiredCount === 4);
    expect(two, "no 2-piece set bonus found").toBeDefined();
    expect(four, "no 4-piece set bonus found").toBeDefined();
    expect(two!.description.length).toBeGreaterThan(0);
    expect(four!.description.length).toBeGreaterThan(0);
  });

  it("has all 7 seasonal artifacts, each with 3 non-empty perk tiers", () => {
    // The 2026 "Monument of Triumph" system exposes 7 artifacts (current + last
    // 6 seasons). They live in DestinyInventoryItemDefinition as "Artifact"
    // items with sockets (NOT DestinyArtifactDefinition, which returns only the
    // current one). Each has 3 perk tiers (socket groups 2/3/2) + a reset
    // socket that we drop; tier perk pools are ~8/15/22.
    expect(ds.artifacts.length).toBe(7);
    for (const artifact of ds.artifacts) {
      expect(artifact.tiers.length, `${artifact.name} tier count`).toBe(3);
      for (const tier of artifact.tiers) {
        expect(tier.perks.length, `${artifact.name} tier ${tier.tierIndex}`).toBeGreaterThan(0);
        // Pool must offer at least as many perks as the tier's selection ceiling.
        expect(tier.perks.length).toBeGreaterThanOrEqual(tier.slots);
      }
      // Per-tier selection ceilings are 2 / 3 / 2 → 7 perks equippable.
      expect(artifact.tiers.map((t) => t.slots)).toEqual([2, 3, 2]);
    }
    console.log(
      "artifacts: " +
        ds.artifacts
          .map((a) => `"${a.name}" [${a.tiers.map((t) => t.perks.length).join("/")}]`)
          .join(", "),
    );
  });

  it("tagged entities into a non-empty keyword producer index", () => {
    const producerKeywords = Object.keys(ds.indexes.keyword.producers);
    expect(producerKeywords.length).toBeGreaterThan(0);
    // Every producer keyword maps to at least one entity hash.
    for (const keyword of producerKeywords) {
      expect(ds.indexes.keyword.producers[keyword].length).toBeGreaterThan(0);
    }
  });

  it("weapons carry a valid ammo type", () => {
    const valid = new Set(["primary", "special", "heavy"]);
    expect(ds.weapons.every((w) => valid.has(w.ammoType))).toBe(true);
    // Non-Power weapons never use Heavy ammo (requires dummy items to be
    // excluded from weapon classification — see classify.ts isDummy).
    const powerless = ds.weapons.filter((w) => w.slot !== "power");
    expect(powerless.every((w) => w.ammoType !== "heavy")).toBe(true);
  });

  it("groups subclass aspect/fragment pools", () => {
    expect(ds.subclasses.length).toBeGreaterThan(0);
    expect(
      ds.subclasses.some(
        (s) => s.aspectHashes.length > 0 && s.fragmentHashes.length > 0,
      ),
    ).toBe(true);
  });
});
