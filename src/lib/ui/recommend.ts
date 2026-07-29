import { loadDataset } from "@/lib/data";
import { solve, type SolveResult, type SolverContext } from "@/lib/solver";
import type { GuardianClass, SubclassElement } from "@/lib/types";
import { createLookup } from "@/lib/validation";

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

export interface Recommendation {
  result: SolveResult;
  /** The artifact the build was solved against, for display. */
  artifactName: string | undefined;
  /** How long the solve took, so the UI can be honest about cost. */
  elapsedMs: number;
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

  return { result, artifactName: artifact?.name, elapsedMs };
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
