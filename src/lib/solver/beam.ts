import type { Armor, ArmorSlot, ArtifactPerk, Aspect, Build, Fragment, Hash, KeywordTags, Mod, PerkConstraint, SubclassElement, WeaponSlot } from "@/lib/types";
import { EMPTY_TAGS } from "@/lib/types";

import type { Capacity, CapacityModel } from "@/lib/validation";
import { buildCapacityModel, canonicalModCapacityModel, evaluateArtifactCapacity, type ModCapacityModel } from "@/lib/validation";

import type { BuildElement, SynergyScore } from "@/lib/synergy";
import { scoreSynergy } from "@/lib/synergy";

import {
  deriveArtifactPerkPool,
  deriveFragmentPool,
  generateCandidates,
  type Candidate,
  type ModPick,
  type WeaponPick,
} from "./candidates";
import { deriveExoticArmorPool, deriveExoticReach } from "./armor";
import { ASPECT_CAP, deriveAspectPool, deriveAspectReach, fragmentSlotsFor } from "./subclass";
import { deriveModPool, deriveModReach } from "./mods";
import { neutralStatFit } from "./stat-fit";
import type { BoundFn, Infeasibility, SolveOptions, SolverContext, StatFit } from "./types";
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
  /**
   * Class+element-filtered aspect pool. A NON-EMPTY pool is exactly "the aspect dimension
   * is open" — it is empty both when no class is pinned (pools are class-specific, so
   * guessing would offer the wrong class's aspects) and when `ASPECT_CAP` aspects are
   * already pinned.
   */
  aspectPool: Aspect[];
  /** Precomputed loose reachable-union for the still-undecided aspects. */
  aspectReach: BuildElement[];
  /** Aspects pinned in the base build — the floor the solver's choices add to. */
  pinnedAspects: Hash[];
  /**
   * Per-armour-slot mod pool. `undefined` ⇒ the mod dimension is CLOSED, which is the default;
   * it opens only via `SolveOptions.chooseMods` because mods have no natural opening pin.
   */
  modPool?: Map<ArmorSlot, Mod[]>;
  /** Per-slot socket+energy capacity model, under the canonical Armor 3.0 layout. */
  modCapacity?: Map<ArmorSlot, ModCapacityModel>;
  /** Per-slot loose reachable-union for still-addable mods (open-slot bound). */
  modReach?: Map<ArmorSlot, BuildElement[]>;
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
  /**
   * Aspects chosen by the solver, EXCLUDING any pinned in the base build — `makeState`
   * concatenates the two when writing the build, so the pinned ones are never duplicated
   * here. Empty when the dimension is closed, which is what keeps state keys
   * byte-identical to every key written before this dimension existed.
   */
  aspectHashes: Hash[];
  /**
   * Mods the solver has placed, each with the armour SLOT it occupies. A flat hash list would be
   * ambiguous: a general mod fits any slot's general socket, so the slot is part of the decision
   * rather than derivable. Empty when the dimension is closed (it is opt-in), which keeps state
   * keys byte-identical to every key written before it existed.
   */
  mods: ModPick[];
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
  // Every component is appended only when present, so SP3a and slice-1 keys are
  // byte-identical (no exotic and no chosen aspect ⇒ no suffix). Order is fixed —
  // wpn, exo, asp — because the key is compared as a string.
  if (selection.exoticHash !== undefined) key = `${key}|exo:${selection.exoticHash}`;
  if (selection.aspectHashes.length > 0) key = `${key}|asp:${s(selection.aspectHashes)}`;
  if (selection.mods.length > 0) {
    // Slot-qualified and sorted: the same mod on two slots is two distinct decisions, and order
    // of placement is not part of a state's identity.
    const mods = [...selection.mods]
      .map((m) => `${m.slot}=${m.hash}`)
      .sort()
      .join(";");
    key = `${key}|mod:${mods}`;
  }
  return key;
}

/**
 * Resolve the pinned inputs into a `SolverEnv`, or explain why they admit no completion
 * (element pinned, artifact resolvable, pinned perks within capacity, pinned fragments
 * within the slot cap, every open weapon slot satisfiable, exotic pins consistent).
 *
 * Every cause is ACCUMULATED rather than short-circuited, so a caller learns everything
 * wrong with a build in one pass — two unsatisfiable weapon slots report two reasons, not
 * the first one found. Checks that genuinely depend on an earlier result (artifact
 * capacity needs a resolved artifact) are the only ones nested.
 *
 * `env` is non-null exactly when `reasons` is empty.
 */
export function resolveSolverEnv(
  base: Build,
  ctx: SolverContext,
  options: SolveOptions = {},
): { env: SolverEnv | null; reasons: Infeasibility[] } {
  const reasons: Infeasibility[] = [];

  const element = base.subclass.element;
  if (element === undefined) {
    reasons.push({
      code: "SUBCLASS_ELEMENT_UNPINNED",
      message: "No subclass element is pinned. The solver derives the fragment and aspect "
        + "pools from the element, so it must be chosen before a build can be completed.",
    });
  }

  const artifactHash = base.artifact.artifactHash;
  const artifact = artifactHash === undefined ? undefined : ctx.lookup.artifact(artifactHash);
  let capModel: CapacityModel | undefined;
  if (!artifact) {
    reasons.push({
      code: "ARTIFACT_UNRESOLVED",
      message: artifactHash === undefined
        ? "No artifact is pinned, so the artifact-perk pool cannot be derived."
        : `Artifact ${artifactHash} is not in the dataset, so its perk pool cannot be derived.`,
      hashes: artifactHash === undefined ? undefined : [artifactHash],
    });
  } else {
    capModel = buildCapacityModel(artifact);
    const pinned = base.artifact.selectedPerkHashes;
    if (!evaluateArtifactCapacity(capModel, pinned).feasible) {
      reasons.push({
        code: "ARTIFACT_PERKS_OVER_CAPACITY",
        message: `The ${pinned.length} pinned artifact perk(s) cannot be placed in `
          + `${artifact.name}'s sockets — they over-subscribe at least one tier threshold.`,
        hashes: [...pinned],
      });
    }
  }

  // Aspects. The dimension is OPEN iff a class is pinned (pools are class-specific) AND
  // fewer than ASPECT_CAP aspects are pinned. An empty pool ⇔ closed, as with exotics.
  const pinnedAspects = base.subclass.aspectHashes;
  const aspectsWanted = ASPECT_CAP - pinnedAspects.length;
  let aspectPool: Aspect[] = [];
  // A pinned class is REQUIRED to open the dimension, not merely preferred: without it the
  // pool would have to span all three classes and the solver would emit illegal builds.
  // Absent classType ⇒ pool stays empty ⇒ dimension closed ⇒ byte-compatible with every
  // build that predates this dimension.
  if (element !== undefined && aspectsWanted > 0 && base.subclass.classType !== undefined) {
    aspectPool = deriveAspectPool(ctx, element, base.subclass.classType)
      .filter((a) => !pinnedAspects.includes(a.hash));
    if (aspectPool.length < aspectsWanted) {
      // Fewer choosable aspects than empty slots — including a pool of zero — so no state
      // can ever reach ASPECT_CAP. Said here rather than letting the search run and
      // degrade to the much vaguer NO_COMPLETION_FOUND.
      reasons.push({
        code: "ASPECT_POOL_TOO_SMALL",
        message: `${pinnedAspects.length} aspect(s) are pinned and only ${aspectPool.length} `
          + `more are available for this class and element, but a build requires `
          + `${ASPECT_CAP}.`,
      });
    }
  }

  // Fragment cap from the PINNED aspects. When the aspect dimension is open this is only a
  // FLOOR — `makeState` recomputes the cap per state as aspects are chosen, because it
  // grows monotonically with each one.
  const fragmentCap = fragmentSlotsFor(ctx, pinnedAspects);
  // So the "too many pinned fragments" test must compare against the BEST cap still
  // reachable, not the floor: with the dimension open, the solver may yet choose aspects
  // that grant the slots those fragments need. Take the `aspectsWanted` most generous pool
  // entries — an upper bound, so this never reports a false infeasibility.
  const bestExtraSlots = aspectPool
    .map((a) => a.fragmentSlots)
    .sort((x, y) => y - x)
    .slice(0, Math.max(0, aspectsWanted))
    .reduce((sum, n) => sum + n, 0);
  const maxFragmentCap = fragmentCap + bestExtraSlots;
  if (base.subclass.fragmentHashes.length > maxFragmentCap) {
    reasons.push({
      code: "FRAGMENTS_EXCEED_ASPECT_SLOTS",
      message: aspectPool.length > 0
        ? `${base.subclass.fragmentHashes.length} fragment(s) are pinned but even the most `
          + `generous aspects available grant only ${maxFragmentCap} fragment slot(s).`
        : `${base.subclass.fragmentHashes.length} fragment(s) are pinned but the chosen `
          + `aspects grant only ${fragmentCap} fragment slot(s).`,
      hashes: [...base.subclass.fragmentHashes],
    });
  }

  const openWeaponSlots: WeaponSlot[] = [];
  const weaponPool = new Map<WeaponSlot, LegalWeapon[]>();
  const weaponReach = new Map<WeaponSlot, BuildElement[]>();
  for (const sel of base.weapons) {
    if (sel.itemHash !== undefined) continue; // pinned slot — not searched
    const pins: PerkConstraint[] = sel.perkConstraints;
    const pool = deriveWeaponPool(ctx, sel.slot, pins);
    if (pool.length === 0) {
      // Reported per slot, so a build with several bad slots names all of them.
      reasons.push({
        code: "WEAPON_SLOT_NO_LEGAL_ITEM",
        message: pins.length === 0
          ? `No weapon in the dataset fits the ${sel.slot} slot.`
          : `No ${sel.slot} weapon can satisfy the ${pins.length} pinned perk constraint(s).`,
        slot: sel.slot,
      });
      continue;
    }
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
  let pinnedExotic: Hash | undefined;
  for (const c of base.constraints) {
    if (c.kind === "useExotic") pinnedExotic = c.itemHash;
  }
  const exoticPiece = base.armor.pieces.find(
    (p) => p.itemHash !== undefined && ctx.lookup.armor(p.itemHash)?.tier === "exotic",
  );
  const classType = base.subclass.classType;
  let exoticPool: Armor[] = [];
  if (exoticPiece !== undefined && pinnedExotic !== undefined
      && pinnedExotic !== exoticPiece.itemHash) {
    // A pin naming a different exotic than the one already equipped as a piece. Closing
    // this was deferred out of slice 2b: the dimension is closed by the piece, so pool
    // derivation never ran and the empty-pool path below could not catch it — `solve`
    // returned feasible with builds silently ignoring the pin.
    const want = ctx.lookup.armor(pinnedExotic)?.name ?? `exotic ${pinnedExotic}`;
    const have = ctx.lookup.armor(exoticPiece.itemHash!)?.name ?? `exotic ${exoticPiece.itemHash}`;
    reasons.push({
      code: "EXOTIC_PIN_CONTRADICTS_PINNED_PIECE",
      message: `The build pins ${want} via a useExotic constraint, but its ${exoticPiece.slot} `
        + `slot already holds the exotic ${have}. A build may hold only one exotic armor piece.`,
      hashes: [pinnedExotic, exoticPiece.itemHash!],
    });
  } else if (base.armor.exoticHash === undefined && exoticPiece === undefined
      && (classType !== undefined || pinnedExotic !== undefined)) {
    exoticPool = deriveExoticArmorPool(ctx, classType, pinnedExotic);
    if (exoticPool.length === 0) {
      reasons.push({
        code: "EXOTIC_POOL_EMPTY",
        message: pinnedExotic === undefined
          ? `No Armor 3.0 exotic armor matches the ${classType} class.`
          // The Armor 3.0 clause matters: the manifest holds ~2.47x legacy duplicates of every
          // exotic, so a pin can name a real, class-correct hash that is nonetheless a legacy
          // copy. Saying only "absent from the dataset" would be actively misleading there.
          : `The pinned exotic ${pinnedExotic} is not an Armor 3.0 piece for the `
            + `${classType ?? "chosen"} class — it is absent from the dataset, belongs to `
            + `another class, or is a legacy (pre-Armor 3.0) copy of an exotic.`,
        hashes: pinnedExotic === undefined ? undefined : [pinnedExotic],
      });
    }
  }

  // Mods. Opt-in only (`SolveOptions.chooseMods`): mods are always available, so unlike every
  // other dimension nothing in the build naturally opens them, and defaulting to on would change
  // the search for every existing build. Modelled PER SLOT against the canonical Armor 3.0 layout,
  // which is what lets mods work at all given the solver never writes `armor.pieces`.
  const ARMOR_SLOTS: ArmorSlot[] = ["helmet", "arms", "chest", "legs", "class"];
  let modSurfaces: {
    modPool?: Map<ArmorSlot, Mod[]>;
    modCapacity?: Map<ArmorSlot, ModCapacityModel>;
    modReach?: Map<ArmorSlot, BuildElement[]>;
  } = {};
  if (options.chooseMods === true) {
    const modPool = new Map<ArmorSlot, Mod[]>();
    const modCapacity = new Map<ArmorSlot, ModCapacityModel>();
    const modReach = new Map<ArmorSlot, BuildElement[]>();
    for (const slot of ARMOR_SLOTS) {
      const pool = deriveModPool(ctx, slot);
      if (pool.length === 0) continue;
      modPool.set(slot, pool);
      modCapacity.set(slot, canonicalModCapacityModel(slot));
      modReach.set(slot, deriveModReach(pool));
    }
    if (modPool.size > 0) modSurfaces = { modPool, modCapacity, modReach };
  }

  if (reasons.length > 0 || element === undefined || !artifact || !capModel) {
    return { env: null, reasons };
  }

  return { env: {
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
    aspectPool,
    aspectReach: deriveAspectReach(aspectPool),
    pinnedAspects,
    ...modSurfaces,
  }, reasons };
}

/**
 * The env alone, or `null` when the pinned inputs admit no completion.
 *
 * A thin projection of `resolveSolverEnv` — the single source of truth for feasibility —
 * kept because most callers (and every beam-level test) only need "can we search?". Use
 * `resolveSolverEnv` when you need to tell the user WHY not.
 */
export function buildSolverEnv(
  base: Build,
  ctx: SolverContext,
  options: SolveOptions = {},
): SolverEnv | null {
  return resolveSolverEnv(base, ctx, options).env;
}

/** Build a fully-derived state from an open-dimension selection. */
export function makeState(env: SolverEnv, selection: Selection, bound: BoundFn): SolverState {
  // Normalize once: fragment/perk order is not part of a state's identity, so the sorted
  // arrays are what the state carries and what `stateKey` serialises.
  const frag = [...selection.fragHashes].sort((a, b) => a - b);
  const perk = [...selection.perkHashes].sort((a, b) => a - b);
  const { weapons: weaponPicks, exoticHash } = selection;
  const chosenAspects = [...selection.aspectHashes].sort((a, b) => a - b);
  // Slot-then-hash ordering, so placement order is not part of a state's identity.
  const modPicks = [...selection.mods].sort(
    (a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : a.hash - b.hash));
  const normalized: Selection = {
    ...selection, fragHashes: frag, perkHashes: perk, aspectHashes: chosenAspects, mods: modPicks,
  };
  // Pinned aspects plus this state's choices. The solver's `Selection` carries ONLY its own
  // choices, so the two are concatenated here rather than stored merged — that keeps the
  // state key free of the pinned ones and so keeps closed-dimension keys byte-identical.
  const allAspects = [...env.pinnedAspects, ...chosenAspects];
  // THE dynamic cap. Recomputed per state because it grows as aspects are added; monotonic
  // growth is what keeps fill-to-cap satisfiable (see `fragmentSlotsFor`).
  const fragmentCap = fragmentSlotsFor(env.ctx, allAspects);
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
    subclass: { ...env.base.subclass, fragmentHashes: frag, aspectHashes: allAspects },
    // `?? env.base.armor.exoticHash` keeps a base-pinned exotic when this dimension is closed.
    armor: {
      ...env.base.armor,
      exoticHash: exoticHash ?? env.base.armor.exoticHash,
      // `modHashes` is a FLAT list on the Build, so the per-slot assignment stays the solver's
      // internal concern. Base-pinned mods are kept and the solver's picks appended.
      modHashes: modPicks.length > 0
        ? [...env.base.armor.modHashes, ...modPicks.map((m) => m.hash)]
        : env.base.armor.modHashes,
    },
    artifact: { ...env.base.artifact, selectedPerkHashes: perk },
    weapons,
  };
  const cap = evaluateArtifactCapacity(env.capModel, perk);
  const realized = scoreSynergy(build, env.lookup);
  // The derived env carries THIS state's dynamic fragment cap. Passing it this way rather
  // than as another positional parameter keeps `generateCandidates`' signature — and its
  // five positional test call sites — untouched.
  // `allAspects`, NOT `chosenAspects`: the cap is on the build's total, so counting only the
  // solver's own picks would offer ASPECT_CAP more on top of any pinned ones. The pool
  // already excludes pinned hashes, so the union cannot cause a duplicate offer.
  const candidates = generateCandidates(
    { ...env, fragmentCap }, frag, perk, cap, weaponPicks, exoticHash, allAspects, modPicks,
  );
  // Open-slot bound: augment the addable set with each not-yet-decided dimension's
  // precomputed reachable-union (candidates alone under-cover a dimension still open).
  const addable = candidates
    // weapon-, exotic- and aspect-selection tags are covered by their reach unions below
    .filter((c) => c.kind !== "weapon" && c.kind !== "exoticArmor" && c.kind !== "aspect"
      && c.kind !== "mod")
    .map((c) => c.element);
  for (const slot of env.openWeaponSlots) {
    if (!pickBySlot.has(slot)) addable.push(...(env.weaponReach.get(slot) ?? []));
  }
  if (exoticHash === undefined && env.exoticPool.length > 0) addable.push(...env.exoticReach);
  if (allAspects.length < ASPECT_CAP && env.aspectPool.length > 0) {
    addable.push(...env.aspectReach);
  }
  // Per slot, credit the reach only while that slot can still take a mod: a slot whose sockets are
  // full contributes nothing further, so the bound tightens as the build fills. Mod candidates are
  // filtered OUT of `addable` above precisely because this covers them — dropping this push makes
  // the bound ignore mods entirely and UNDER-estimate any mod-undecided state, which breaks the
  // admissibility SP3a's pruning depends on.
  if (env.modPool !== undefined) {
    for (const [slot, model] of env.modCapacity ?? []) {
      if (modPicks.filter((m) => m.slot === slot).length >= model.socketCount) continue;
      addable.push(...(env.modReach?.get(slot) ?? []));
    }
  }
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
    } else if (c.kind === "aspect") {
      out.push(makeState(env, { ...sel, aspectHashes: [...sel.aspectHashes, c.hash], mods: [] }, bound));
    } else if (c.kind === "mod") {
      out.push(makeState(env, {
        ...sel, mods: [...sel.mods, { slot: c.armorSlot!, hash: c.hash }],
      }, bound));
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
  // Aspects: `ASPECT_CAP` is a hard game floor. Counts PINNED + CHOSEN, because
  // `Selection.aspectHashes` carries only the solver's own picks — comparing those alone
  // against the cap would refuse to ever complete a build that had one aspect pinned.
  //
  // Like the exotic clause above, this is DEFENSIVE and unreachable under today's candidate
  // generation (confirmed by mutation: deleting it reddens nothing). `resolveSolverEnv`
  // rejects a pool too small to reach the cap up front (ASPECT_POOL_TOO_SMALL), and
  // `generateCandidates` always offers an unchosen pool entry while under the cap, so an
  // aspect-undecided state always has a move and can never be terminal. Kept because it is
  // correct and cheap, and it stops being dead the moment a future slice can prune aspect
  // moves away (as the ammo prune does for weapons).
  if (env.aspectPool.length > 0
      && env.pinnedAspects.length + state.selection.aspectHashes.length < ASPECT_CAP) {
    return false;
  }
  // MODS DELIBERATELY HAVE NO CLAUSE — and this is the first dimension for which that is correct.
  // Every other dimension is fill-to-cap (a game floor), so an undecided one is a dead end. Mods
  // are not: four sockets exist but four mods at 3 energy is 12 > 11, so the energy budget usually
  // binds first and a FULL mod set is often infeasible. Underfill is therefore legal, and a state
  // that can add no further mod is MAXIMAL rather than incomplete. Since a mod never has a
  // downside, maximal is optimal, so terminal-only routing stays correct without best-partial
  // tracking. Add a clause here only if some future prune can delete mod moves the way the ammo
  // prune deletes weapon moves.
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
    aspectHashes: [],
    mods: [],
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
