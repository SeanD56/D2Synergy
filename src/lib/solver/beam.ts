import type { ArtifactPerk, Build, Fragment, Hash, SubclassElement } from "@/lib/types";

import type { Capacity, CapacityModel } from "@/lib/validation";
import { buildCapacityModel, evaluateArtifactCapacity } from "@/lib/validation";

import type { SynergyScore } from "@/lib/synergy";
import { scoreSynergy } from "@/lib/synergy";

import {
  deriveArtifactPerkPool,
  deriveFragmentPool,
  generateCandidates,
  type Candidate,
} from "./candidates";
import { neutralStatFit } from "./stat-fit";
import type { BoundFn, SolveOptions, SolverContext, StatFit } from "./types";

export const DEFAULT_BEAM_WIDTH = 16;
export const DEFAULT_TOP_N = 5;

/** Everything the beam needs, resolved once from the pinned inputs. */
export interface SolverEnv {
  ctx: SolverContext;
  lookup: SolverContext["lookup"];
  base: Build;
  element: SubclassElement;
  fragmentCap: number;
  fragmentPool: Fragment[];
  capModel: CapacityModel;
  perkPool: ArtifactPerk[];
  beamWidth: number;
  topN: number;
  statFit: StatFit;
}

/** A partial build in the beam. `candidates` are its legal add-one-element moves. */
export interface SolverState {
  build: Build;
  fragHashes: Hash[];
  perkHashes: Hash[];
  cap: Capacity;
  realized: SynergyScore;
  candidates: Candidate[];
  priority: number;
  key: string;
}

/** Order-independent identity for a partial build (dedup + stable tie-break). */
export function stateKey(fragHashes: Hash[], perkHashes: Hash[]): string {
  const s = (xs: Hash[]) => [...xs].sort((a, b) => a - b).join(",");
  return `frag:${s(fragHashes)}|perk:${s(perkHashes)}`;
}

/**
 * Resolve the pinned inputs into a `SolverEnv`, or `null` if they admit no
 * completion at all (SP3a's feasibility = element pinned, artifact resolvable,
 * pinned perks within capacity, pinned fragments within the slot cap).
 */
export function buildSolverEnv(
  base: Build,
  ctx: SolverContext,
  options: SolveOptions = {},
): SolverEnv | null {
  const element = base.subclass.element;
  if (element === undefined) return null;

  const artifactHash = base.artifact.artifactHash;
  const artifact = artifactHash === undefined ? undefined : ctx.lookup.artifact(artifactHash);
  if (!artifact) return null;

  const capModel = buildCapacityModel(artifact);
  if (!evaluateArtifactCapacity(capModel, base.artifact.selectedPerkHashes).feasible) return null;

  const fragmentCap = base.subclass.aspectHashes.reduce(
    (sum, h) => sum + (ctx.lookup.aspect(h)?.fragmentSlots ?? 0),
    0,
  );
  if (base.subclass.fragmentHashes.length > fragmentCap) return null;

  return {
    ctx,
    lookup: ctx.lookup,
    base,
    element,
    fragmentCap,
    fragmentPool: deriveFragmentPool(ctx, element),
    capModel,
    perkPool: deriveArtifactPerkPool(ctx, artifact),
    beamWidth: options.beamWidth ?? DEFAULT_BEAM_WIDTH,
    topN: options.topN ?? DEFAULT_TOP_N,
    statFit: options.statFit ?? neutralStatFit,
  };
}

/** Build a fully-derived state from a fragment/perk selection. */
export function makeState(
  env: SolverEnv,
  fragHashes: Hash[],
  perkHashes: Hash[],
  bound: BoundFn,
): SolverState {
  const frag = [...fragHashes].sort((a, b) => a - b);
  const perk = [...perkHashes].sort((a, b) => a - b);
  const build: Build = {
    ...env.base,
    subclass: { ...env.base.subclass, fragmentHashes: frag },
    artifact: { ...env.base.artifact, selectedPerkHashes: perk },
  };
  const cap = evaluateArtifactCapacity(env.capModel, perk);
  const realized = scoreSynergy(build, env.lookup);
  const candidates = generateCandidates(env, frag, perk, cap);
  const priority = bound(build, candidates.map((c) => c.element), env.lookup);
  return { build, fragHashes: frag, perkHashes: perk, cap, realized, candidates, priority, key: stateKey(frag, perk) };
}

/** All successor states — one per legal move from `state`. */
export function expand(state: SolverState, env: SolverEnv, bound: BoundFn): SolverState[] {
  return state.candidates.map((c) =>
    c.kind === "fragment"
      ? makeState(env, [...state.fragHashes, c.hash], state.perkHashes, bound)
      : makeState(env, state.fragHashes, [...state.perkHashes, c.hash], bound),
  );
}

/**
 * Beam search over the two open dimensions. Each round expands the beam, routes
 * terminal (no-move) states to `completed`, dedups successors by build key, and
 * keeps the top-`beamWidth` by priority (ties broken by key). Because the
 * priority is an admissible upper bound, a promising producer is never pruned
 * before its consumer can be added.
 */
export function beamSearch(env: SolverEnv, bound: BoundFn): SolverState[] {
  let beam: SolverState[] = [makeState(env, env.base.subclass.fragmentHashes, env.base.artifact.selectedPerkHashes, bound)];
  const completed: SolverState[] = [];
  const seen = new Set<string>();

  while (beam.length > 0) {
    const byKey = new Map<string, SolverState>();
    for (const state of beam) {
      const kids = expand(state, env, bound);
      if (kids.length === 0) {
        completed.push(state);
        continue;
      }
      for (const kid of kids) {
        if (seen.has(kid.key) || byKey.has(kid.key)) continue;
        byKey.set(kid.key, kid);
      }
    }
    for (const key of byKey.keys()) seen.add(key);
    beam = [...byKey.values()]
      .sort((a, b) => b.priority - a.priority || b.realized.score - a.realized.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .slice(0, env.beamWidth);
  }

  return completed;
}
