import type { Armor, ArtifactPerk, Build, Fragment, Hash, KeywordTags, PerkConstraint, SubclassElement, WeaponSlot } from "@/lib/types";
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
import { deriveExoticArmorPool, deriveExoticReach } from "./armor";
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
  /** Plug → tags resolver: side table by hash, then the name bridge, then empty. */
  resolvePlugTags: (plug: { hash: Hash; name: string }) => KeywordTags;
  /**
   * Class-filtered, name-deduped exotic pool. A NON-EMPTY pool is exactly equivalent to
   * "the exotic dimension is open" — `buildSolverEnv` returns null when the dimension is
   * open but admits nothing, so no separate flag is needed.
   */
  exoticPool: Armor[];
  /** Precomputed loose reachable-union for the undecided exotic (open-slot bound). */
  exoticReach: BuildElement[];
}

/**
 * Every open-dimension decision a partial build carries, as ONE object.
 *
 * Carried (and spread) as a unit so that `expand` forwards each dimension it is not
 * changing **by default**, and dropping one has to be written deliberately. The
 * previous shape — a positional parameter per dimension, manually re-listed in each
 * of `expand`'s branches — made omission the silent case: nothing type-checks a
 * missing trailing argument, so a dropped decision surfaced only as a wrong build.
 *
 * Add a field here when a slice opens a new dimension; `expand`'s spreads then pick
 * it up with no per-branch edit, and `dimensionsAllDecided` is the one place that
 * needs to learn what "decided" means for it.
 */
export interface Selection {
  fragHashes: Hash[];
  perkHashes: Hash[];
  /** Weapons chosen for open slots (pinned slots live in `build`). */
  weapons: WeaponPick[];
  /** The chosen exotic, when this dimension is open and decided. */
  exoticHash?: Hash;
}

/** A partial build in the beam. `candidates` are its legal add-one-element moves. */
export interface SolverState {
  build: Build;
  /** The open-dimension decisions behind `build`; `fragHashes`/`perkHashes` are sorted. */
  selection: Selection;
  cap: Capacity;
  realized: SynergyScore;
  candidates: Candidate[];
  priority: number;
  key: string;
}

/** Order-independent identity for a partial build (dedup + stable tie-break). */
export function stateKey(selection: Selection): string {
  const s = (xs: Hash[]) => [...xs].sort((a, b) => a - b).join(",");
  let key = `frag:${s(selection.fragHashes)}|perk:${s(selection.perkHashes)}`;
  if (selection.weapons.length > 0) {
    const wpn = [...selection.weapons]
      .sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0))
      .map((p) => `${p.slot}=${p.itemHash}[${s(p.plugHashes)}]`)
      .join(";");
    key = `${key}|wpn:${wpn}`;
  }
  // Both components are appended only when present, so SP3a and slice-1 keys are
  // byte-identical (no exotic ⇒ no suffix).
  if (selection.exoticHash !== undefined) key = `${key}|exo:${selection.exoticHash}`;
  return key;
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

  const resolvePlugTags = (plug: { hash: Hash; name: string }) =>
    ctx.lookup.plugTags(plug.hash) ?? ctx.lookup.perkByName(plug.name)?.tags ?? EMPTY_TAGS;

  // Exotic armor. The dimension is OPEN iff the base does not already fix an exotic — in
  // EITHER armor field, since a build may record its exotic as a piece (see `ArmorLoadout`)
  // — AND we have either a Guardian class to filter by or a useExotic pin. Checking both
  // fields is what makes "non-empty pool ⇔ dimension open" true against the whole armor
  // model: without it, a user who pins an exotic *piece* gets a SECOND exotic chosen here.
  // (A useExotic pin alongside an exotic piece therefore closes the dimension rather than
  // producing two exotics; slice 4's infeasibility explanation is where that gets voiced.)
  let pinnedExotic: Hash | undefined;
  for (const c of base.constraints) {
    if (c.kind === "useExotic") pinnedExotic = c.itemHash;
  }
  const pieceExotic = base.armor.pieces.some(
    (p) => p.itemHash !== undefined && ctx.lookup.armor(p.itemHash)?.tier === "exotic",
  );
  const classType = base.subclass.classType;
  let exoticPool: Armor[] = [];
  if (base.armor.exoticHash === undefined && !pieceExotic
      && (classType !== undefined || pinnedExotic !== undefined)) {
    exoticPool = deriveExoticArmorPool(ctx, classType, pinnedExotic);
    // Pin contradicts the class, or names a hash absent from the dataset. Slice 4 will
    // explain WHICH; here it is simply infeasible.
    if (exoticPool.length === 0) return null;
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
    resolvePlugTags,
    exoticPool,
    exoticReach: deriveExoticReach(exoticPool),
  };
}

/** Build a fully-derived state from an open-dimension selection. */
export function makeState(env: SolverEnv, selection: Selection, bound: BoundFn): SolverState {
  // Normalize once: fragment/perk order is not part of a state's identity, so the sorted
  // arrays are what the state carries and what `stateKey` serialises.
  const frag = [...selection.fragHashes].sort((a, b) => a - b);
  const perk = [...selection.perkHashes].sort((a, b) => a - b);
  const { weapons: weaponPicks, exoticHash } = selection;
  const normalized: Selection = { ...selection, fragHashes: frag, perkHashes: perk };
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
    // `?? env.base.armor.exoticHash` keeps a base-pinned exotic when this dimension is closed.
    armor: { ...env.base.armor, exoticHash: exoticHash ?? env.base.armor.exoticHash },
    artifact: { ...env.base.artifact, selectedPerkHashes: perk },
    weapons,
  };
  const cap = evaluateArtifactCapacity(env.capModel, perk);
  const realized = scoreSynergy(build, env.lookup);
  const candidates = generateCandidates(env, frag, perk, cap, weaponPicks, exoticHash);
  // Open-slot bound: augment the addable set with each not-yet-decided dimension's
  // precomputed reachable-union (candidates alone under-cover a dimension still open).
  const addable = candidates
    // weapon- and exotic-selection tags are covered by their reach unions below
    .filter((c) => c.kind !== "weapon" && c.kind !== "exoticArmor")
    .map((c) => c.element);
  for (const slot of env.openWeaponSlots) {
    if (!pickBySlot.has(slot)) addable.push(...(env.weaponReach.get(slot) ?? []));
  }
  if (exoticHash === undefined && env.exoticPool.length > 0) addable.push(...env.exoticReach);
  const priority = bound(build, addable, env.lookup);
  return { build, selection: normalized, cap, realized, candidates, priority,
    key: stateKey(normalized) };
}

/**
 * All successor states — one per legal move from `state`.
 *
 * Each branch spreads `state.selection` and overrides ONLY the dimension its move
 * changes; every other decision rides along untouched. Dropping a decision therefore
 * requires explicitly writing it back out (e.g. `exoticHash: undefined`) rather than
 * merely forgetting an argument — which is the whole point of carrying `Selection`.
 */
export function expand(state: SolverState, env: SolverEnv, bound: BoundFn): SolverState[] {
  const out: SolverState[] = [];
  const sel = state.selection;
  for (const c of state.candidates) {
    if (c.kind === "fragment") {
      out.push(makeState(env, { ...sel, fragHashes: [...sel.fragHashes, c.hash] }, bound));
    } else if (c.kind === "artifactPerk") {
      out.push(makeState(env, { ...sel, perkHashes: [...sel.perkHashes, c.hash] }, bound));
    } else if (c.kind === "exoticArmor") {
      out.push(makeState(env, { ...sel, exoticHash: c.hash }, bound));
    } else if (c.kind === "weapon") {
      // Choose a weapon for slot c.slot. Eager ammo prune: skip if it makes the
      // no-double-Primary rule unsatisfiable across all decided weapons.
      const weapons = [...sel.weapons, { slot: c.slot!, itemHash: c.hash, plugHashes: [] }];
      if (nonPowerAmmoInfeasible(decidedAmmo(env, weapons))) continue;
      out.push(makeState(env, { ...sel, weapons }, bound));
    } else { // weaponPerk
      const weapons = sel.weapons.map((p) =>
        p.slot === c.slot ? { ...p, plugHashes: [...p.plugHashes, c.hash] } : p);
      out.push(makeState(env, { ...sel, weapons }, bound));
    }
  }
  return out;
}

/**
 * Is every open dimension decided? Only a state for which this holds is a deliverable
 * build; a terminal state (no legal move left) can also arise because a prune removed
 * this dimension's moves rather than because it was filled — see `beamSearch`.
 *
 * Fragments and artifact perks are absent by design: for those, "decided" IS
 * terminality (no candidate left ⇒ slot cap reached / capacity exhausted), so they
 * need no clause. A dimension belongs here only when its moves can vanish for a
 * reason other than being complete.
 *
 * ⚠️ Every slice that opens a new such dimension adds ONE clause here — this list is
 * the single reviewable answer to "did we forget a dimension?".
 */
export function dimensionsAllDecided(state: SolverState, env: SolverEnv): boolean {
  // Weapons: the ammo eager-prune (`expand`'s "weapon" branch) can delete every move for
  // an open slot, leaving it forever undecided — a dead end, not a completion.
  if (state.selection.weapons.length !== env.openWeaponSlots.length) return false;
  // Exotic armor: DEFENSIVE and — unlike the weapon clause — unreachable under today's
  // candidate generation. `generateCandidates` emits one `exoticArmor` candidate per pool
  // entry whenever `exoticHash === undefined`, and `expand` never `continue`s on that kind,
  // so an exotic-undecided state always has a move and can never be terminal. Kept because
  // it is correct and cheap, and it stops being dead the moment a future slice adds a
  // dimension whose moves can be pruned away (as the ammo prune does for weapons).
  if (state.selection.exoticHash === undefined && env.exoticPool.length > 0) return false;
  return true;
}

/** Ammo type of every DECIDED weapon (pinned base weapons + current picks). */
function decidedAmmo(env: SolverEnv, picks: Selection["weapons"]) {
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
  let beam: SolverState[] = [makeState(env, {
    fragHashes: env.base.subclass.fragmentHashes,
    perkHashes: env.base.artifact.selectedPerkHashes,
    weapons: [],
  }, bound)];
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
        // But "no move left" is not sufficient: a dimension's moves can also vanish
        // to a prune rather than to genuine exhaustion (the ammo eager-prune — see
        // `dimensionsAllDecided`, which enumerates every such dimension). That leaves
        // the dimension forever undecided, making the state a dead end rather than a
        // deliverable, so it is discarded rather than completed. Confirmed empirically:
        // two open, both-Primary-only slots otherwise leak two single-slot-filled
        // "completions" into `completed` without this guard.
        if (dimensionsAllDecided(state, env)) completed.push(state);
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
