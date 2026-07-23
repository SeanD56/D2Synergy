import type { SubclassElement } from "@/lib/types";

import type { BuildElement, Synergy } from "./types";
import {
  CHAIN_BASE,
  ELEMENT_ALIGNED_MULT,
  TRIGGER_GROUP_CAP,
  TRIGGER_SHARE,
} from "./weights";

export interface ChainResult {
  synergies: Synergy[];
  /** Keywords with at least one producer left unpaired (and not self-satisfied). */
  unusedProducers: string[];
  /** Keywords with at least one consumer left unpaired (and not self-satisfied). */
  unmetConsumers: string[];
}

const byHash = (a: BuildElement, b: BuildElement) => a.hash - b.hash;

function aligned(el: BuildElement, subclassElement?: SubclassElement): boolean {
  return (
    subclassElement !== undefined &&
    (el.tags.element === subclassElement || el.tags.element === "prismatic")
  );
}

/** Match producer→consumer chains per keyword with escalating (1,2,3,…) weights. */
export function matchChains(
  elements: BuildElement[],
  subclassElement?: SubclassElement,
): ChainResult {
  const synergies: Synergy[] = [];
  const unusedProducers: string[] = [];
  const unmetConsumers: string[] = [];

  const keywords = new Set<string>();
  for (const el of elements) {
    for (const k of el.tags.produces) keywords.add(k);
    for (const k of el.tags.consumes) keywords.add(k);
  }

  for (const K of [...keywords].sort()) {
    const producers = elements.filter((e) => e.tags.produces.includes(K)).sort(byHash);
    const consumers = elements.filter((e) => e.tags.consumes.includes(K)).sort(byHash);
    const usedConsumer = new Set<BuildElement>();
    const matchedProducer = new Set<BuildElement>();
    let rank = 0;

    for (const p of producers) {
      const c = consumers.find((cand) => cand !== p && !usedConsumer.has(cand));
      if (!c) continue;
      usedConsumer.add(c);
      matchedProducer.add(p);
      rank += 1;
      let weight = CHAIN_BASE * rank;
      if (aligned(p, subclassElement) && aligned(c, subclassElement)) {
        weight *= ELEMENT_ALIGNED_MULT;
      }
      const suffix = rank > 1 ? ` (link #${rank}, ×${rank})` : "";
      synergies.push({
        fromHash: p.hash,
        toHash: c.hash,
        via: K,
        weight,
        why: `${p.source} creates ${K} → ${c.source} benefits from ${K}${suffix}`,
      });
    }

    // Leftovers: a produce+consume element self-satisfies, so it isn't a gap.
    if (producers.some((p) => !matchedProducer.has(p) && !p.tags.consumes.includes(K))) {
      unusedProducers.push(K);
    }
    if (consumers.some((c) => !usedConsumer.has(c) && !c.tags.produces.includes(K))) {
      unmetConsumers.push(K);
    }
  }

  return { synergies, unusedProducers, unmetConsumers };
}

/** Lower-weight synergies for elements sharing a trigger, capped per group. */
export function triggerSynergies(elements: BuildElement[]): Synergy[] {
  const byTrigger = new Map<string, BuildElement[]>();
  for (const el of elements) {
    for (const t of el.tags.triggers) {
      byTrigger.set(t, [...(byTrigger.get(t) ?? []), el]);
    }
  }

  const out: Synergy[] = [];
  for (const t of [...byTrigger.keys()].sort()) {
    const group = [...(byTrigger.get(t) ?? [])].sort(byHash);
    let count = 0;
    for (let i = 0; i < group.length && count < TRIGGER_GROUP_CAP; i++) {
      for (let j = i + 1; j < group.length && count < TRIGGER_GROUP_CAP; j++) {
        out.push({
          fromHash: group[i].hash,
          toHash: group[j].hash,
          via: `trigger:${t}`,
          weight: TRIGGER_SHARE,
          why: `${group[i].source} and ${group[j].source} both trigger on ${t}`,
        });
        count += 1;
      }
    }
  }
  return out;
}
