import type { Artifact, Hash } from "@/lib/types";

/**
 * Per-artifact precompute for capacity checks. Built ONCE per artifact; the SP3
 * beam search hoists this out of its inner loop and reuses it across selections.
 */
export interface CapacityModel {
  /** Perk hash -> lowest (native) tier index it appears in. */
  nativeTier: Map<Hash, number>;
  /** socketsByTier[t] = number of sockets in tier t (index === tierIndex). */
  socketsByTier: number[];
  /** Total sockets across all tiers (Σ socketsByTier). */
  capacity: number;
}

/** Per-selection capacity verdict. `feasible` means "not over capacity". */
export interface Capacity {
  /** True iff a legal socket assignment exists (partial selections are feasible). */
  feasible: boolean;
  /** Count of distinct, placeable (known) selected perks. */
  selected: number;
  /** === model.capacity, echoed for convenience. */
  capacity: number;
  /**
   * headroomByTier[k] = free sockets available to a perk whose NATIVE tier is k
   * = (sockets with tier >= k) − (selected perks with native tier >= k).
   * `feasible` iff every entry >= 0.
   */
  headroomByTier: number[];
}

/**
 * Artifact tiers are a cumulative CEILING: a tier-T socket accepts perks native
 * to tier <= T, so a perk's native tier (its lowest appearance) is the floor of
 * sockets it can occupy. Resolve native tiers + per-tier socket counts once.
 */
export function buildCapacityModel(artifact: Artifact): CapacityModel {
  const tiers = [...artifact.tiers].sort((a, b) => a.tierIndex - b.tierIndex);
  const nativeTier = new Map<Hash, number>();
  const socketsByTier: number[] = [];
  for (const tier of tiers) {
    socketsByTier[tier.tierIndex] = tier.slots;
    for (const p of tier.perks) {
      if (!nativeTier.has(p.hash)) nativeTier.set(p.hash, tier.tierIndex);
    }
  }
  const capacity = socketsByTier.reduce((sum, n) => sum + (n ?? 0), 0);
  return { nativeTier, socketsByTier, capacity };
}

/**
 * Feasibility over the nested socket structure. Because socket neighborhoods are
 * upward-closed (a perk fits any socket of tier >= its native tier), Hall's
 * condition reduces to checking, at every tier threshold k, that the perks
 * requiring tier >= k do not outnumber the sockets of tier >= k. This is exact —
 * see the completeness test against a bipartite-matching reference.
 */
export function evaluate(model: CapacityModel, selectedHashes: Hash[]): Capacity {
  const nTiers = model.socketsByTier.length;

  // Distinct, placeable (known) perks only; unknowns are perkMembership's job.
  const placeable = [...new Set(selectedHashes)].filter((h) =>
    model.nativeTier.has(h),
  );

  // needAtOrAbove[k] = count of selected perks whose native tier >= k.
  const needAtOrAbove = new Array<number>(nTiers).fill(0);
  for (const h of placeable) {
    const t = model.nativeTier.get(h)!;
    for (let k = 0; k <= t; k++) needAtOrAbove[k] += 1;
  }

  // headroomByTier[k] = (Σ_{t>=k} sockets) − needAtOrAbove[k].
  const headroomByTier = new Array<number>(nTiers).fill(0);
  let socketsAtOrAbove = 0;
  for (let k = nTiers - 1; k >= 0; k--) {
    socketsAtOrAbove += model.socketsByTier[k] ?? 0;
    headroomByTier[k] = socketsAtOrAbove - needAtOrAbove[k];
  }

  return {
    feasible: headroomByTier.every((h) => h >= 0),
    selected: placeable.length,
    capacity: model.capacity,
    headroomByTier,
  };
}

/**
 * O(tier) incremental prune for beam search: can a perk with the given native
 * tier be added to the selection `cap` describes and stay feasible? Adding a
 * native-tier-t perk consumes one socket from every threshold k <= t, so every
 * such threshold must have >= 1 headroom. Assumes the perk is placeable and not
 * already selected (caller's responsibility).
 */
export function canAdd(
  model: CapacityModel,
  cap: Capacity,
  nativeTier: number,
): boolean {
  const upper = Math.min(nativeTier, cap.headroomByTier.length - 1);
  for (let k = 0; k <= upper; k++) {
    if (cap.headroomByTier[k] < 1) return false;
  }
  return true;
}
