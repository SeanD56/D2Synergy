import type { Build } from "@/lib/types";

import type { Lookup } from "@/lib/validation/types";

import { collectBuildElements } from "./elements";
import { matchChains, triggerSynergies } from "./graph";
import type { BuildElement, OverlayEntry, Synergy, SynergyScore } from "./types";
import { CURATED_OVERLAY } from "./weights";

/** Curated overlay entries whose both endpoints are present in the build. */
export function overlaySynergies(
  elements: BuildElement[],
  entries: OverlayEntry[] = CURATED_OVERLAY,
): Synergy[] {
  const present = new Set(elements.map((e) => e.hash));
  return entries
    .filter((o) => present.has(o.fromHash) && present.has(o.toHash))
    .map((o) => ({ fromHash: o.fromHash, toHash: o.toHash, via: o.via, weight: o.weight, why: o.why }));
}

/** Enumerate all synergies present in a build. */
export function getSynergies(build: Build, lookup: Lookup): Synergy[] {
  const elements = collectBuildElements(build, lookup);
  const chains = matchChains(elements, build.subclass.element);
  return [...chains.synergies, ...triggerSynergies(elements), ...overlaySynergies(elements)];
}

/** Score a build's synergy. `score === Σ synergy weight`. */
export function scoreSynergy(build: Build, lookup: Lookup): SynergyScore {
  const synergies = getSynergies(build, lookup);
  const score = synergies.reduce((sum, s) => sum + s.weight, 0);
  return { score, synergies };
}
