import type { ArtifactPerk, Build, Fragment, Hash, PerkConstraint, SubclassElement, WeaponSlot } from "@/lib/types";

import type { Capacity, CapacityModel } from "@/lib/validation";
import { buildCapacityModel, evaluateArtifactCapacity } from "@/lib/validation";

import type { BuildElement, SynergyScore } from "@/lib/synergy";
import { scoreSynergy } from "@/lib/synergy";

import {
  deriveArtifactPerkPool,
  deriveFragmentPool,
  generateCandidates,
  type Candidate,
} from "./candidates";
import { neutralStatFit } from "./stat-fit";
import type { BoundFn, SolveOptions, SolverContext, StatFit } from "./types";
import { deriveWeaponPool, deriveWeaponSlotReach, type LegalWeapon } from "./weapons";

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
  /** Top-N cut applied by solve() during final ranking; unused inside the beam. */
  topN: number;
  statFit: StatFit;
  /** Weapon slots the solver must fill (itemHash undefined in the base). */
  openWeaponSlots: WeaponSlot[];
  /** Membership-filtered legal weapons per open slot. */
  weaponPool: Map<WeaponSlot, LegalWeapon[]>;
  /** Precomputed loose reachable-union per open slot (for the open-slot bound). */
  weaponReach: Map<WeaponSlot, BuildElement[]>;
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

  const openWeaponSlots: WeaponSlot[] = [];
  const weaponPool = new Map<WeaponSlot, LegalWeapon[]>();
  const weaponReach = new Map<WeaponSlot, BuildElement[]>();
  for (const sel of base.weapons) {
    if (sel.itemHash !== undefined) continue; // pinned slot — not searched
    const pins: PerkConstraint[] = sel.perkConstraints;
    const pool = deriveWeaponPool(ctx, sel.slot, pins);
    if (pool.length === 0) return null; // no weapon can satisfy this slot's pins
    openWeaponSlots.push(sel.slot);
    weaponPool.set(sel.slot, pool);
    weaponReach.set(sel.slot, deriveWeaponSlotReach(ctx, pool));
  }

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
    openWeaponSlots,
    weaponPool,
    weaponReach,
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
  // SP3b: cap/synergy/candidates/bound are recomputed per successor from scratch;
  // incrementalize when more open dimensions are added.
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
 * terminal states to `completed`, dedups successors by build key, and keeps the
 * top-`beamWidth` by priority — ties broken by realized synergy, then by key for
 * determinism. Because `priority` is an admissible upper bound (computed fresh
 * over the reachable set, not incrementally), the path to the best reachable
 * completion is never pruned before its consumer can be added.
 *
 * Only TERMINAL states — no legal move left (fragment slots full, artifact perk
 * pool exhausted or capacity-bound) — are returned as completion candidates.
 * This is intentional: the game floors require a build filled to its caps (all
 * fragment slots, artifact tiers filled to `slots`), so an underfilled partial
 * is not a valid deliverable. Note `scoreSynergy` is NOT monotonic under adding
 * elements (see `synergyUpperBound`), so a filled build can score below some
 * underfilled ancestor — but that ancestor is not a legal output, and the
 * admissible bound still guarantees the best *filled* build is retained. (SP3b,
 * with dynamic caps, must revisit this if it ever allows underfill.)
 */
export function beamSearch(env: SolverEnv, bound: BoundFn): SolverState[] {
  let beam: SolverState[] = [makeState(env, env.base.subclass.fragmentHashes, env.base.artifact.selectedPerkHashes, bound)];
  const completed: SolverState[] = [];
  // Global dedup: a build key seen in any round is never expanded again, even via
  // a later path to the same element set (same set ⇒ identical state, so safe).
  const seen = new Set<string>();

  while (beam.length > 0) {
    const byKey = new Map<string, SolverState>();
    for (const state of beam) {
      const kids = expand(state, env, bound);
      if (kids.length === 0) {
        // Terminal: no fragment slot or capacity-legal perk left → a filled,
        // deliverable build. Only filled builds are valid outputs (see docstring).
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
