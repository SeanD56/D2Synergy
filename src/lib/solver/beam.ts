import type { ArtifactPerk, Build, Fragment, Hash, KeywordTags, PerkConstraint, SubclassElement, WeaponSlot } from "@/lib/types";
import { EMPTY_TAGS } from "@/lib/types";

import type { Capacity, CapacityModel } from "@/lib/validation";
import { buildCapacityModel, evaluateArtifactCapacity } from "@/lib/validation";

import type { BuildElement, SynergyScore } from "@/lib/synergy";
import { scoreSynergy } from "@/lib/synergy";

import {
  deriveArtifactPerkPool,
  deriveFragmentPool,
  generateCandidates,
  type Candidate,
  type WeaponPick,
} from "./candidates";
import { neutralStatFit } from "./stat-fit";
import type { BoundFn, SolveOptions, SolverContext, StatFit } from "./types";
import {
  deriveWeaponPool,
  deriveWeaponSlotReach,
  nonPowerAmmoInfeasible,
  type LegalWeapon,
} from "./weapons";

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
  /** Name-bridge resolver for weapon plug tags (empty tags if unmatched). */
  resolvePlugTags: (name: string) => KeywordTags;
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
  /** Weapons chosen for open slots (pinned slots live in `build`). */
  weapons: WeaponPick[];
}

/** Order-independent identity for a partial build (dedup + stable tie-break). */
export function stateKey(fragHashes: Hash[], perkHashes: Hash[], weaponPicks: WeaponPick[] = []): string {
  const s = (xs: Hash[]) => [...xs].sort((a, b) => a - b).join(",");
  const base = `frag:${s(fragHashes)}|perk:${s(perkHashes)}`;
  if (weaponPicks.length === 0) return base; // SP3a keys unchanged (byte-identical)
  const wpn = [...weaponPicks]
    .sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0))
    .map((p) => `${p.slot}=${p.itemHash}[${s(p.plugHashes)}]`)
    .join(";");
  return `${base}|wpn:${wpn}`;
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

  const resolvePlugTags = (name: string) => ctx.lookup.perkByName(name)?.tags ?? EMPTY_TAGS;

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
    resolvePlugTags,
  };
}

/** Build a fully-derived state from a fragment/perk/weapon selection. */
export function makeState(
  env: SolverEnv,
  fragHashes: Hash[],
  perkHashes: Hash[],
  bound: BoundFn,
  weaponPicks: WeaponPick[] = [],
): SolverState {
  const frag = [...fragHashes].sort((a, b) => a - b);
  const perk = [...perkHashes].sort((a, b) => a - b);
  const pickBySlot = new Map(weaponPicks.map((p) => [p.slot, p]));
  const weapons = env.base.weapons.map((sel) => {
    const pick = sel.itemHash === undefined ? pickBySlot.get(sel.slot) : undefined;
    if (!pick) return sel; // pinned slot, or open slot not yet given a weapon
    const weapon = env.lookup.weapon(pick.itemHash);
    const plugConstraints = pick.plugHashes.map((h) => {
      let name = "", column = -1;
      for (const col of weapon?.perkColumns ?? []) {
        const plug = col.plugs.find((p) => p.hash === h);
        if (plug) { name = plug.name; column = col.socketIndex; break; }
      }
      return { perkHash: h, perkName: name, column };
    });
    return { ...sel, itemHash: pick.itemHash, perkConstraints: [...sel.perkConstraints, ...plugConstraints] };
  });
  const build: Build = {
    ...env.base,
    subclass: { ...env.base.subclass, fragmentHashes: frag },
    artifact: { ...env.base.artifact, selectedPerkHashes: perk },
    weapons,
  };
  const cap = evaluateArtifactCapacity(env.capModel, perk);
  const realized = scoreSynergy(build, env.lookup);
  const candidates = generateCandidates(env, frag, perk, cap, weaponPicks);
  // Open-slot bound: augment the addable set with each not-yet-picked slot's precomputed
  // reachable-union (candidates alone under-cover a slot whose weapon isn't chosen yet).
  const addable = candidates
    .filter((c) => c.kind !== "weapon") // weapon-selection tags are covered by weaponReach
    .map((c) => c.element);
  for (const slot of env.openWeaponSlots) {
    if (!pickBySlot.has(slot)) addable.push(...(env.weaponReach.get(slot) ?? []));
  }
  const priority = bound(build, addable, env.lookup);
  return { build, fragHashes: frag, perkHashes: perk, cap, realized, candidates, priority,
    weapons: weaponPicks, key: stateKey(frag, perk, weaponPicks) };
}

/** All successor states — one per legal move from `state`. */
export function expand(state: SolverState, env: SolverEnv, bound: BoundFn): SolverState[] {
  const out: SolverState[] = [];
  for (const c of state.candidates) {
    if (c.kind === "fragment") {
      out.push(makeState(env, [...state.fragHashes, c.hash], state.perkHashes, bound, state.weapons));
    } else if (c.kind === "artifactPerk") {
      out.push(makeState(env, state.fragHashes, [...state.perkHashes, c.hash], bound, state.weapons));
    } else if (c.kind === "weapon") {
      // Choose a weapon for slot c.slot. Eager ammo prune: skip if it makes the
      // no-double-Primary rule unsatisfiable across all decided weapons.
      const decided = decidedAmmo(env, [...state.weapons, { slot: c.slot!, itemHash: c.hash, plugHashes: [] }]);
      if (nonPowerAmmoInfeasible(decided)) continue;
      out.push(makeState(env, state.fragHashes, state.perkHashes, bound,
        [...state.weapons, { slot: c.slot!, itemHash: c.hash, plugHashes: [] }]));
    } else { // weaponPerk
      const nextPicks = state.weapons.map((p) =>
        p.slot === c.slot ? { ...p, plugHashes: [...p.plugHashes, c.hash] } : p);
      out.push(makeState(env, state.fragHashes, state.perkHashes, bound, nextPicks));
    }
  }
  return out;
}

/** Ammo type of every DECIDED weapon (pinned base weapons + current picks). */
function decidedAmmo(env: SolverEnv, picks: SolverState["weapons"]) {
  const decided: Array<{ slot: WeaponSlot; ammoType: "primary" | "special" | "heavy" }> = [];
  for (const sel of env.base.weapons) {
    if (sel.itemHash === undefined) continue;
    const w = env.lookup.weapon(sel.itemHash);
    if (w) decided.push({ slot: sel.slot, ammoType: w.ammoType });
  }
  for (const p of picks) {
    const w = env.lookup.weapon(p.itemHash);
    if (w) decided.push({ slot: p.slot, ammoType: w.ammoType });
  }
  return decided;
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
        //
        // A weapon-kind candidate can also vanish via the ammo eager-prune
        // (`expand`'s `continue` in the "weapon" branch) rather than genuine
        // exhaustion of the weapon dimension — that would leave an open weapon
        // slot forever undecided. Such a state is a dead end (this partial can
        // never legally reach a filled build), not a deliverable — so it is
        // discarded rather than completed. Confirmed empirically: two open,
        // both-Primary-only slots otherwise leak two single-slot-filled
        // "completions" into `completed` without this guard.
        if (state.weapons.length === env.openWeaponSlots.length) {
          completed.push(state);
        }
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
