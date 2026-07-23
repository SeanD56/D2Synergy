import type { Build } from "@/lib/types";

import { synergyUpperBound } from "@/lib/synergy";

import { beamSearch, buildSolverEnv, type SolverState } from "./beam";
import type { BoundFn, RankedBuild, SolveOptions, SolveResult, SolverContext } from "./types";

/**
 * Complete a partially-pinned build over its two open dimensions (subclass
 * fragments + artifact perks) and return the top-N by synergy + stat-fit.
 *
 * Contract: `build.subclass.element` + `aspectHashes` and `artifact.artifactHash`
 * are pinned; the solver fills `fragmentHashes` + `selectedPerkHashes`. Any
 * fragments/perks already present are kept. `feasible` is false (with no builds)
 * iff the pinned inputs admit no completion.
 */
export function solve(build: Build, ctx: SolverContext, options: SolveOptions = {}): SolveResult {
  const env = buildSolverEnv(build, ctx, options);
  if (env === null) return { builds: [], feasible: false };

  const bound: BoundFn = options.bound ?? synergyUpperBound;
  const completed = beamSearch(env, bound);

  const ranked = completed
    .map((state: SolverState): RankedBuild & { key: string } => {
      const statFit = env.statFit(state.build, ctx);
      return { build: state.build, synergy: state.realized, statFit, score: state.realized.score + statFit, key: state.key };
    })
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, env.topN)
    .map(({ key: _key, ...rest }) => rest);

  return { builds: ranked, feasible: true };
}
