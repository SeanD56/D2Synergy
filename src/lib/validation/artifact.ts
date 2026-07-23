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
 * Phase 1 (partial): artifact tiers are a CEILING — a tier-T socket accepts its
 * own perks plus every lower tier's perks, so the derived pools are cumulative
 * (7/14/21) and a perk hash appears in every tier at/above where it unlocks.
 * A flat selectedPerkHashes list can't say which socket each perk fills, so we
 * validate only what IS soundly checkable from the flat set: the total count
 * against the combined ceiling, and a nested-ceiling guard (perks that can only
 * sit in tier >= k must fit the sockets of tiers >= k). This never rejects a
 * feasible selection. The full per-socket assignment model is deferred to the
 * Phase 2 artifact-model rework. See memory: artifact-tier-pools-cumulative.
 */
const tierCapacity: Rule = (build, lookup) => {
  const { artifactHash, selectedPerkHashes } = build.artifact;
  if (artifactHash === undefined) return [];
  const artifact = lookup.artifact(artifactHash);
  if (!artifact) return [];

  // Native tier = the first (lowest) tier a perk appears in; the perk is
  // equippable in any socket of that tier or higher.
  const nativeTier = new Map<number, number>();
  for (const tier of artifact.tiers) {
    for (const p of tier.perks) {
      if (!nativeTier.has(p.hash)) nativeTier.set(p.hash, tier.tierIndex);
    }
  }

  const totalSlots = artifact.tiers.reduce((sum, t) => sum + t.slots, 0);

  // Distinct, known (placeable) selected perks. Unknown hashes are handled by
  // perkMembership and excluded from capacity accounting.
  const selected = [...new Set(selectedPerkHashes)].filter((h) =>
    nativeTier.has(h),
  );

  const out: Violation[] = [];

  const overByCount = selected.length > totalSlots;
  if (overByCount) {
    out.push({
      code: "ARTIFACT_TIER_OVER_CAP",
      category: "game",
      message: `${selected.length} artifact perks selected; only ${totalSlots} can be equipped.`,
      subject: { kind: "artifact", hash: artifact.hash },
    });
  } else if (selected.length < totalSlots) {
    out.push({
      code: "ARTIFACT_TIER_UNDERFILLED",
      category: "game",
      message: `Fill all ${totalSlots} artifact perk slots; ${selected.length} selected.`,
      subject: { kind: "artifact", hash: artifact.hash },
    });
  }

  // Nested ceiling: walking tiers high -> low, the perks whose native tier is
  // >= the current tier can only occupy sockets of tiers >= it. If they
  // outnumber those sockets, no assignment exists -> genuinely over capacity.
  // (Skipped when already over by total count, which subsumes this.)
  if (!overByCount) {
    const byIndexDesc = [...artifact.tiers].sort(
      (a, b) => b.tierIndex - a.tierIndex,
    );
    let cumulativeSlots = 0;
    let cumulativeNeed = 0;
    for (const tier of byIndexDesc) {
      cumulativeSlots += tier.slots;
      cumulativeNeed += selected.filter(
        (h) => nativeTier.get(h) === tier.tierIndex,
      ).length;
      if (cumulativeNeed > cumulativeSlots) {
        out.push({
          code: "ARTIFACT_TIER_OVER_CAP",
          category: "game",
          message: `Too many perks require tier ${tier.tierIndex + 1} or higher (${cumulativeNeed} for ${cumulativeSlots} sockets).`,
          subject: { kind: "artifact", hash: artifact.hash },
        });
        break;
      }
    }
  }

  return out;
};

export const artifactRules: Rule[] = [perkMembership, tierCapacity];
