import type { Artifact, ArtifactPerk, Fragment, Hash, SubclassElement } from "@/lib/types";

import type { Capacity, CapacityModel } from "@/lib/validation";
import { canAddArtifactPerk } from "@/lib/validation";

import type { BuildElement } from "@/lib/synergy";

import type { SolverContext } from "./types";

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

/** One legal move: add a fragment or an artifact perk to an open dimension. */
export interface Candidate {
  kind: "fragment" | "artifactPerk";
  hash: Hash;
  /** Native (lowest) tier — present only for artifact perks (for canAdd). */
  nativeTier?: number;
  /** Resolved tagged element, for the optimistic bound. */
  element: BuildElement;
}

/** The pieces of the solver env candidate generation needs (structural subset). */
interface CandidateEnv {
  fragmentPool: Fragment[];
  perkPool: ArtifactPerk[];
  fragmentCap: number;
  capModel: CapacityModel;
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

  return out;
}
