import type { Artifact, ArtifactPerk, Fragment, Hash, KeywordTags, SubclassElement, WeaponSlot } from "@/lib/types";

import type { Capacity, CapacityModel } from "@/lib/validation";
import { canAddArtifactPerk } from "@/lib/validation";

import type { BuildElement } from "@/lib/synergy";

import type { SolverContext } from "./types";
import type { LegalWeapon } from "./weapons";

const byHash = (a: { hash: Hash }, b: { hash: Hash }) => a.hash - b.hash;

/** The pinned element's fragment pool: element items that resolve to fragments. */
export function deriveFragmentPool(ctx: SolverContext, element: SubclassElement): Fragment[] {
  const hashes = ctx.indexes.elementToItems[element] ?? [];
  const seen = new Set<Hash>();
  const pool: Fragment[] = [];
  for (const h of hashes) {
    if (seen.has(h)) continue;
    const f = ctx.lookup.fragment(h);
    if (f && f.element === element) {
      seen.add(h);
      pool.push(f);
    }
  }
  return pool.sort(byHash);
}

/** The pinned artifact's distinct perks (pools are cumulative → dedup by hash). */
export function deriveArtifactPerkPool(_ctx: SolverContext, artifact: Artifact): ArtifactPerk[] {
  const seen = new Set<Hash>();
  const pool: ArtifactPerk[] = [];
  for (const tier of artifact.tiers) {
    for (const p of tier.perks) {
      if (seen.has(p.hash)) continue;
      seen.add(p.hash);
      pool.push(p);
    }
  }
  return pool.sort(byHash);
}

/** One legal move: add a fragment, artifact perk, weapon, or weapon plug to an open dimension. */
export interface Candidate {
  kind: "fragment" | "artifactPerk" | "weapon" | "weaponPerk";
  hash: Hash;
  /** Native (lowest) tier — present only for artifact perks (for canAdd). */
  nativeTier?: number;
  /** Weapon slot — present for "weapon" and "weaponPerk" moves. */
  slot?: WeaponSlot;
  /** Target column socketIndex — present for "weaponPerk" moves. */
  column?: number;
  /** Resolved tagged element, for the optimistic bound. */
  element: BuildElement;
}

/** A weapon being filled in an open slot: chosen weapon + plugs chosen so far. */
export interface WeaponPick {
  slot: WeaponSlot;
  itemHash: Hash;
  /** Chosen plug hashes (⊆ the weapon's open columns), in the order added. */
  plugHashes: Hash[];
}

/** The pieces of the solver env candidate generation needs (structural subset). */
interface CandidateEnv {
  fragmentPool: Fragment[];
  perkPool: ArtifactPerk[];
  fragmentCap: number;
  capModel: CapacityModel;
  openWeaponSlots: WeaponSlot[];
  weaponPool: Map<WeaponSlot, LegalWeapon[]>;
  /** Name-bridge resolver for weapon plug tags (empty tags if unmatched). */
  resolvePlugTags: (name: string) => KeywordTags;
}

/**
 * Every legal add-one-element move from the given partial selection. Fragments
 * are offered only while under the aspect-granted slot cap; artifact perks only
 * when placeable (known native tier) and the SP2 oracle admits the addition.
 * Already-chosen hashes are never re-offered.
 */
export function generateCandidates(
  env: CandidateEnv,
  fragHashes: Hash[],
  perkHashes: Hash[],
  cap: Capacity,
  weaponPicks: WeaponPick[],
): Candidate[] {
  const chosenFrag = new Set(fragHashes);
  const chosenPerk = new Set(perkHashes);
  const out: Candidate[] = [];

  if (fragHashes.length < env.fragmentCap) {
    for (const f of env.fragmentPool) {
      if (chosenFrag.has(f.hash)) continue;
      out.push({ kind: "fragment", hash: f.hash, element: { hash: f.hash, source: `fragment:${f.name}`, tags: f.tags } });
    }
  }

  for (const p of env.perkPool) {
    if (chosenPerk.has(p.hash)) continue;
    const nativeTier = env.capModel.nativeTier.get(p.hash);
    if (nativeTier === undefined) continue; // unplaceable (unknown) perk
    if (!canAddArtifactPerk(env.capModel, cap, nativeTier)) continue;
    out.push({ kind: "artifactPerk", hash: p.hash, nativeTier, element: { hash: p.hash, source: `artifact-perk:${p.name}`, tags: p.tags } });
  }

  const pickBySlot = new Map(weaponPicks.map((p) => [p.slot, p]));
  for (const slot of env.openWeaponSlots) {
    const pick = pickBySlot.get(slot);
    if (!pick) {
      // No weapon chosen yet → offer each legal weapon (hash-sorted by the pool).
      for (const { weapon } of env.weaponPool.get(slot) ?? []) {
        out.push({ kind: "weapon", hash: weapon.hash, slot,
          element: { hash: weapon.hash, source: `weapon:${weapon.name}`, tags: weapon.tags } });
      }
      continue;
    }
    // Weapon chosen → offer one plug per still-unfilled open column.
    const legal = (env.weaponPool.get(slot) ?? []).find((l) => l.weapon.hash === pick.itemHash);
    if (!legal) continue;
    const chosen = new Set(pick.plugHashes);
    for (const col of legal.openColumns) {
      if (col.plugs.some((p) => chosen.has(p.hash))) continue; // column already filled
      for (const plug of col.plugs) {
        // Note: candidate/element hash is plugItemHash (identity for move/state), while realized
        // synergy and weaponReach key by resolved sandbox-perk hash (name bridge). Hash asymmetry
        // is safe—only over-counts admissible bound, never under-counts. Unifies when Option A lands.
        out.push({ kind: "weaponPerk", hash: plug.hash, slot, column: col.socketIndex,
          element: { hash: plug.hash, source: `perk:${plug.name}`, tags: env.resolvePlugTags(plug.name) } });
      }
    }
  }

  return out;
}
