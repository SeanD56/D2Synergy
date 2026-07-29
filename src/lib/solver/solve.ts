import type { Build } from "@/lib/types";

import { synergyUpperBound } from "@/lib/synergy";

import { beamSearch, resolveSolverEnv, type SolverState } from "./beam";
import type { BoundFn, RankedBuild, SolveOptions, SolveResult, SolverContext } from "./types";

/**
 * Complete a partially-pinned build over its open dimensions (subclass
 * fragments, artifact perks, and weapon selection + roll) and return the top-N
 * by synergy + stat-fit.
 *
 * Contract: `build.subclass.element` + `aspectHashes` and `artifact.artifactHash`
 * are pinned; the solver fills `fragmentHashes` + `selectedPerkHashes` and any
 * open weapon slots (`itemHash` undefined) with a weapon and full roll. Any
 * fragments/perks/weapons already present are kept. `feasible` is false (with no
 * builds) iff the pinned inputs admit no completion.
 */
export function solve(build: Build, ctx: SolverContext, options: SolveOptions = {}): SolveResult {
  const { env, reasons } = resolveSolverEnv(build, ctx, options);
  if (env === null) return { builds: [], feasible: false, reasons };

  const bound: BoundFn = options.bound ?? synergyUpperBound;
  const completed = beamSearch(env, bound);

  if (completed.length === 0) {
    // The pinned inputs passed every env-level check, yet the search produced no filled
    // build — every path ran into a prune (today: the ammo eager-prune) or a dead end.
    // Reported as its own SEARCH-level code rather than `feasible: true` with zero builds,
    // which told a UI "your build is fine" while handing it nothing to show.
    return { builds: [], feasible: false, reasons: [{
      code: "NO_COMPLETION_FOUND",
      message: "The pinned inputs are individually satisfiable, but the search finished "
        + "without completing a single build — every branch hit a dead end (for example, "
        + "two open non-Power slots that can only be filled with Primary-ammo weapons). "
        + "Because beam search is incomplete, this reports what the search found rather "
        + "than proving no build exists.",
    }] };
  }

  const ranked = completed
    .map((state: SolverState): RankedBuild & { key: string } => {
      const statFit = env.statFit(state.build, ctx);
      return { build: state.build, synergy: state.realized, statFit, score: state.realized.score + statFit, key: state.key };
    })
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, env.topN)
    .map(({ key: _key, ...rest }) => rest);

  return { builds: ranked, feasible: true, reasons: [] };
}
