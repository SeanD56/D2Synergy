import { loadDataset } from "@/lib/data";
import { solve, type SolveResult, type SolverContext } from "@/lib/solver";
import type { Build, GuardianClass, Hash, SubclassElement } from "@/lib/types";
import { createLookup, type Lookup } from "@/lib/validation";

/**
 * The UI's entry point into the solver.
 *
 * SERVER-ONLY: `loadDataset` reads `data/*.json` from the filesystem, so this must never be
 * imported into a Client Component. It is kept out of the page component so the solver call is
 * unit-testable without rendering anything.
 *
 * Deliberately thin — it resolves defaults and delegates. Every real decision (which dimensions
 * are open, what is feasible, how builds rank) belongs to the solver, not here.
 */

/** What the user has pinned. Everything else is the solver's to choose. */
export interface RecommendInput {
  element: SubclassElement;
  /**
   * Guardian class. Load-bearing beyond filtering: its presence is what OPENS the
   * solver-chosen exotic-armour and aspect dimensions (see `resolveSolverEnv`), so omitting it
   * yields a much smaller search rather than an error.
   */
  classType?: Exclude<GuardianClass, "any">;
  /** Open the mod dimension. Default false — it costs ~5.4x and ~4.4s (see integration-mods). */
  chooseMods?: boolean;
}

/**
 * Entity NAMES for one ranked build.
 *
 * The page renders the build summary exclusively from this, never from the `Build`'s hash arrays —
 * so "a hash reached the screen" is a defect visible in one place instead of at every render site.
 */
export interface BuildDisplay {
  /** The chosen exotic, or `undefined` when the dimension is CLOSED (no class pinned). */
  exoticName: string | undefined;
  aspectNames: string[];
  fragmentNames: string[];
  artifactPerkNames: string[];
}

export interface Recommendation {
  result: SolveResult;
  /** Display names per ranked build, INDEX-ALIGNED with `result.builds`. */
  displays: BuildDisplay[];
  /** The artifact the build was solved against, for display. */
  artifactName: string | undefined;
  /** How long the solve took, so the UI can be honest about cost. */
  elapsedMs: number;
}

/**
 * Resolve a build's hashes to display names through the `Lookup` seam — the same seam the solver
 * selects from — rather than by indexing dataset arrays, so the UI cannot drift from the solver's
 * view of the dataset.
 *
 * THROWS on a hash that does not resolve. Resolution is total by construction: every hash in a
 * solved build was drawn from a pool derived through this same `Lookup`, so a miss is a real defect
 * (a bad pin, or an ingest that dropped an entity). Falling back to the hash would put an
 * unactionable digit string on screen and hide the defect, which is what this task removed.
 */
export function resolveDisplay(build: Build, lookup: Lookup): BuildDisplay {
  const names = <T extends { name: string }>(
    hashes: readonly Hash[],
    kind: string,
    resolve: (hash: Hash) => T | undefined,
  ): string[] => hashes.map((hash) => {
    const entity = resolve(hash);
    if (entity === undefined) throw new Error(`Unresolvable ${kind} hash ${hash} in solved build`);
    return entity.name;
  });

  const { exoticHash } = build.armor;

  return {
    exoticName: exoticHash === undefined
      ? undefined
      : names([exoticHash], "exotic armor", (h) => lookup.armor(h))[0],
    aspectNames: names(build.subclass.aspectHashes, "aspect", (h) => lookup.aspect(h)),
    fragmentNames: names(build.subclass.fragmentHashes, "fragment", (h) => lookup.fragment(h)),
    artifactPerkNames: names(
      build.artifact.selectedPerkHashes, "artifact perk", (h) => lookup.artifactPerk(h),
    ),
  };
}

/**
 * Solve for a pinned element (and optionally class), returning the ranked builds.
 *
 * The artifact is defaulted to the CURRENT seasonal one via `Lookup.currentArtifact()`. That
 * matters: a player has exactly one active artifact, so picking any of the 7 arbitrarily would
 * recommend perks they cannot access. If it cannot be resolved, this returns an infeasible result
 * carrying the solver's own `ARTIFACT_UNRESOLVED` reason rather than guessing.
 */
export async function recommend(input: RecommendInput): Promise<Recommendation> {
  const dataset = await loadDataset();
  const lookup = createLookup(dataset);
  const ctx: SolverContext = { lookup, indexes: dataset.indexes };

  const artifact = lookup.currentArtifact();

  const build = {
    subclass: {
      element: input.element,
      classType: input.classType,
      aspectHashes: [],
      fragmentHashes: [],
    },
    weapons: [],
    armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
    // `artifactHash: undefined` is passed through deliberately when unresolved: the solver reports
    // ARTIFACT_UNRESOLVED, which is a better answer than silently substituting a wrong season.
    artifact: { artifactHash: artifact?.hash, selectedPerkHashes: [] },
    constraints: [],
  } as unknown as Parameters<typeof solve>[0];

  const startedAt = performance.now();
  const result = solve(build, ctx, { chooseMods: input.chooseMods ?? false });
  const elapsedMs = Math.round(performance.now() - startedAt);

  const displays = result.builds.map((ranked) => resolveDisplay(ranked.build, lookup));

  return { result, displays, artifactName: artifact?.name, elapsedMs };
}

/** The elements a build may pin, for rendering the picker. */
export const SUBCLASS_ELEMENTS: readonly SubclassElement[] = [
  "arc", "solar", "void", "stasis", "strand", "prismatic",
];

/** The three Guardian classes, for rendering the picker. */
export const GUARDIAN_CLASSES: readonly Exclude<GuardianClass, "any">[] = [
  "hunter", "titan", "warlock",
];

/** Narrow an untrusted query-string value to a pinnable element. */
export function parseElement(raw: string | string[] | undefined): SubclassElement | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return SUBCLASS_ELEMENTS.find((e) => e === value);
}

/** Narrow an untrusted query-string value to a Guardian class. */
export function parseClassType(
  raw: string | string[] | undefined,
): Exclude<GuardianClass, "any"> | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return GUARDIAN_CLASSES.find((c) => c === value);
}
