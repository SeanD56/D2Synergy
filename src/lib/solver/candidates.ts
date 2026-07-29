import type { Armor, Artifact, ArtifactPerk, Aspect, Fragment, Hash, KeywordTags, SubclassElement, WeaponSlot } from "@/lib/types";

import type { Capacity, CapacityModel } from "@/lib/validation";
import { canAddArtifactPerk } from "@/lib/validation";

import type { BuildElement } from "@/lib/synergy";

import { ASPECT_CAP } from "./subclass";
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
  kind: "fragment" | "artifactPerk" | "weapon" | "weaponPerk" | "exoticArmor" | "aspect";
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
  /**
   * Fragment slots available to THIS state. With aspects solver-chosen the cap is dynamic,
   * so `makeState` passes a derived env carrying the per-state value rather than the
   * env-wide one (see its `fragmentSlotsFor` call).
   */
  fragmentCap: number;
  capModel: CapacityModel;
  openWeaponSlots: WeaponSlot[];
  weaponPool: Map<WeaponSlot, LegalWeapon[]>;
  /** Plug → tags resolver: side table by hash, then the name bridge, then empty. */
  resolvePlugTags: (plug: { hash: Hash; name: string }) => KeywordTags;
  /** Class-filtered, name-deduped exotic pool. EMPTY ⇒ the exotic dimension is closed. */
  exoticPool: Armor[];
  /**
   * Class+element-filtered aspect pool. EMPTY (or absent) ⇒ the aspect dimension is closed.
   * Optional so the several test envs that predate this dimension still satisfy the type.
   */
  aspectPool?: Aspect[];
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
  exoticHash?: Hash,
  aspectHashes: Hash[] = [],
): Candidate[] {
  const chosenFrag = new Set(fragHashes);
  const chosenPerk = new Set(perkHashes);
  const out: Candidate[] = [];

  // Aspects: a subset-fill to the ASPECT_CAP game floor, like fragments — and, like them,
  // single-stage (choosing an aspect decides it outright; there is no second stage). Offered
  // before fragments because an aspect is what GRANTS fragment slots: with zero aspects the
  // dynamic cap is 0, so `fragmentCap` below legitimately offers nothing yet.
  if (aspectHashes.length < ASPECT_CAP) {
    const chosenAspect = new Set(aspectHashes);
    for (const a of env.aspectPool ?? []) {
      if (chosenAspect.has(a.hash)) continue;
      out.push({ kind: "aspect", hash: a.hash,
        element: { hash: a.hash, source: `aspect:${a.name}`, tags: a.tags } });
    }
  }

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

  // Exotic armor: a single-select dimension. Unlike weapons there is no second stage —
  // an exotic's slot is fixed by the item, so choosing the item decides the slot.
  if (exoticHash === undefined) {
    for (const a of env.exoticPool) {
      out.push({ kind: "exoticArmor", hash: a.hash,
        element: { hash: a.hash, source: `armor:${a.name}`, tags: a.tags } });
    }
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
        // Candidate/element hash is the plugItemHash, and the side table is keyed by the same
        // hash — so a plug's TAGS now resolve on its own identity (slice 2a), no name bridge
        // needed. Note `weaponReach` still dedups at sandbox-perk granularity on purpose: it is
        // a bound input, not a move identity (see deriveWeaponSlotReach).
        out.push({ kind: "weaponPerk", hash: plug.hash, slot, column: col.socketIndex,
          element: { hash: plug.hash, source: `perk:${plug.name}`, tags: env.resolvePlugTags(plug) } });
      }
    }
  }

  return out;
}
