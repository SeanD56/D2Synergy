import type { Armor, ArmorSlot, Artifact, ArtifactPerk, Aspect, Fragment, Hash, KeywordTags, Mod, SubclassElement, WeaponSlot } from "@/lib/types";

import type { Capacity, CapacityModel } from "@/lib/validation";
import { canAddArtifactPerk, canAddMod, type ModCapacityModel } from "@/lib/validation";

import type { BuildElement } from "@/lib/synergy";

import { ASPECT_CAP } from "./subclass";
import type { SolverContext } from "./types";
import type { LegalWeapon } from "./weapons";

const byHash = (a: { hash: Hash }, b: { hash: Hash }) => a.hash - b.hash;

/**
 * Resolve a placed mod hash back to what the capacity oracle needs. Falls back to a zero-cost
 * unmatchable entry if the hash does not resolve, which makes the selection look INFEASIBLE
 * rather than silently free — the conservative direction.
 */
function placeable(env: CandidateEnv, hash: Hash): { category: string; energyCost: number } {
  for (const pool of env.modPool?.values() ?? []) {
    const found = pool.find((m) => m.hash === hash);
    if (found) return { category: found.plugCategory, energyCost: found.energyCost };
  }
  return { category: "\u0000unresolved", energyCost: 0 };
}

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
  kind: "fragment" | "artifactPerk" | "weapon" | "weaponPerk" | "exoticArmor" | "aspect" | "mod";
  hash: Hash;
  /** Native (lowest) tier — present only for artifact perks (for canAdd). */
  nativeTier?: number;
  /** Weapon slot — present for "weapon" and "weaponPerk" moves. */
  slot?: WeaponSlot;
  /**
   * ARMOUR slot — present for "mod" moves. Deliberately a separate field from `slot`: conflating
   * an armour slot with a weapon slot in one property would type-check but let a weapon branch
   * silently consume a mod candidate.
   */
  armorSlot?: ArmorSlot;
  /** Target column socketIndex — present for "weaponPerk" moves. */
  column?: number;
  /** Resolved tagged element, for the optimistic bound. */
  element: BuildElement;
}

/** One mod the solver has placed, and the armour slot it occupies. */
export interface ModPick {
  slot: ArmorSlot;
  hash: Hash;
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
  /**
   * Per-armour-slot mod pool. ABSENT ⇒ the mod dimension is closed (it is opt-in via
   * `SolveOptions.chooseMods`). Optional so envs predating this dimension still satisfy the type.
   */
  modPool?: Map<ArmorSlot, Mod[]>;
  /** Per-slot capacity model, for the socket+energy feasibility gate. */
  modCapacity?: Map<ArmorSlot, ModCapacityModel>;
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
  modPicks: ModPick[] = [],
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

  // Mods: one move per (armour slot, legal mod) still admissible under that slot's socket and
  // energy budget. `canAddMod` is the gate, so a slot whose energy is spent stops offering moves
  // and the state becomes terminal with FEWER mods than sockets — underfill is legal here, unlike
  // every other dimension (see `dimensionsAllDecided`).
  if (env.modPool !== undefined) {
    for (const [armorSlot, pool] of env.modPool) {
      const current = modPicks.filter((p) => p.slot === armorSlot);
      const placed = current.map((p) => placeable(env, p.hash));
      const model = env.modCapacity?.get(armorSlot);
      if (!model) continue;
      const chosenHere = new Set(current.map((p) => p.hash));
      for (const m of pool) {
        // A mod may be worn once per slot; the same mod on a different slot is a distinct move.
        if (chosenHere.has(m.hash)) continue;
        if (!canAddMod(model, placed, { category: m.plugCategory, energyCost: m.energyCost })) continue;
        out.push({ kind: "mod", hash: m.hash, armorSlot,
          element: { hash: m.hash, source: `mod:${m.name}`, tags: m.tags } });
      }
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
