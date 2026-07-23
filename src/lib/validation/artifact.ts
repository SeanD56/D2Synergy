import type { Rule, Violation } from "./types";
import { buildCapacityModel, evaluate } from "./artifact-capacity";

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
 * Artifact tiers are a cumulative CEILING (a tier-T socket accepts tier <= T
 * perks; pools are cumulative 7/14/21). Capacity legality is a nested bipartite
 * feasibility problem, delegated to the pure `artifact-capacity` oracle — the
 * same oracle the SP3 solver uses. This rule is a thin adapter: over capacity ->
 * ARTIFACT_TIER_OVER_CAP; feasible-but-not-full -> ARTIFACT_TIER_UNDERFILLED
 * (a build-canvas advisory). At most one fires; an over-constrained selection
 * is reported as OVER_CAP, never simultaneously "underfilled". Unknown perks
 * are handled by `perkMembership` and ignored here. See memory:
 * artifact-tier-pools-cumulative.
 */
const tierCapacity: Rule = (build, lookup) => {
  const { artifactHash, selectedPerkHashes } = build.artifact;
  if (artifactHash === undefined) return [];
  const artifact = lookup.artifact(artifactHash);
  if (!artifact) return [];

  const cap = evaluate(buildCapacityModel(artifact), selectedPerkHashes);

  if (!cap.feasible) {
    return [
      {
        code: "ARTIFACT_TIER_OVER_CAP",
        category: "game",
        message: `Too many artifact perks for the available sockets (capacity ${cap.capacity}).`,
        subject: { kind: "artifact", hash: artifact.hash },
      },
    ];
  }
  if (cap.selected < cap.capacity) {
    return [
      {
        code: "ARTIFACT_TIER_UNDERFILLED",
        category: "game",
        message: `Fill all ${cap.capacity} artifact perk slots; ${cap.selected} selected.`,
        subject: { kind: "artifact", hash: artifact.hash },
      },
    ];
  }
  return [];
};

export const artifactRules: Rule[] = [perkMembership, tierCapacity];
