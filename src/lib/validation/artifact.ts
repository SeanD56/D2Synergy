import type { Rule, Violation } from "./types";

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

/**
 * Phase 1 (partial): tiers are a ceiling — a higher-tier socket accepts its own
 * perks PLUS all lower-tier perks, so the derived pools are cumulative (7/14/21)
 * and a perk hash appears in every tier at/above where it unlocks. We attribute
 * each selected perk to its first (native) tier and count 2/3/2 against that.
 * This is correct for canonical native-per-tier selections but UNDER-constrains
 * cross-tier ones (a flat selectedPerkHashes list can't say which socket a perk
 * fills). A correct check is a nested feasibility/matching test; deferred to the
 * Phase 2 artifact-model rework. See memory: artifact-tier-pools-cumulative.
 */
const tierCapacity: Rule = (build, lookup) => {
  const { artifactHash, selectedPerkHashes } = build.artifact;
  if (artifactHash === undefined) return [];
  const artifact = lookup.artifact(artifactHash);
  if (!artifact) return [];

  // Map each perk hash to its tier index (first tier it appears in).
  const tierOf = new Map<number, number>();
  for (const tier of artifact.tiers) {
    for (const p of tier.perks) {
      if (!tierOf.has(p.hash)) tierOf.set(p.hash, tier.tierIndex);
    }
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
