import type { Build, Keyword } from "@/lib/types";

import type { Lookup } from "@/lib/validation/types";

import { collectBuildElements } from "./elements";
import type { BuildElement } from "./types";
import {
  CHAIN_BASE,
  CURATED_OVERLAY,
  ELEMENT_ALIGNED_MULT,
  TRIGGER_GROUP_CAP,
  TRIGGER_SHARE,
} from "./weights";

/** Sum of chain ranks 1..n = n(n+1)/2. */
function triangular(n: number): number {
  return (n * (n + 1)) / 2;
}

/**
 * An ADMISSIBLE upper bound on `scoreSynergy(present ∪ S).score` for every
 * `S ⊆ addable`. Used by the solver's beam to prune without ever discarding a
 * partial build whose best completion could still be optimal — in particular a
 * producer whose only consumer is still reachable in an open dimension.
 *
 * It bounds each scoring term over the reachable universe (present ∪ addable),
 * NOT by scoring a concrete build: `scoreSynergy` is non-monotonic under adding
 * elements (a lower-hash unaligned producer can steal a consumer from an aligned
 * one), so no single build's score is a safe bound. Per keyword there are at
 * most `min(#producers, #consumers)` chain links, each ≤ `ELEMENT_ALIGNED_MULT ·
 * CHAIN_BASE · rank`; triggers cap at `TRIGGER_GROUP_CAP` pairs per group; overlay
 * credits any entry whose both endpoints are reachable. Every completion's true
 * score is ≤ this sum.
 */
export function synergyUpperBound(
  present: Build,
  addable: BuildElement[],
  lookup: Lookup,
): number {
  // Reachable universe = present elements ∪ addable, deduped by hash.
  const byHash = new Map<number, BuildElement>();
  for (const e of collectBuildElements(present, lookup)) byHash.set(e.hash, e);
  for (const e of addable) if (!byHash.has(e.hash)) byHash.set(e.hash, e);
  const elements = [...byHash.values()];

  // Chain term: per keyword, min(producers, consumers) links, each optimistically
  // element-aligned (×ELEMENT_ALIGNED_MULT) at rank weights 1,2,3,… (CHAIN_BASE·r).
  const produce = new Map<Keyword, number>();
  const consume = new Map<Keyword, number>();
  for (const e of elements) {
    for (const k of e.tags.produces) produce.set(k, (produce.get(k) ?? 0) + 1);
    for (const k of e.tags.consumes) consume.set(k, (consume.get(k) ?? 0) + 1);
  }
  let chain = 0;
  for (const [k, p] of produce) {
    const pairs = Math.min(p, consume.get(k) ?? 0);
    if (pairs > 0) chain += ELEMENT_ALIGNED_MULT * CHAIN_BASE * triangular(pairs);
  }

  // Trigger term: per trigger group of size n, up to TRIGGER_GROUP_CAP pairs.
  const triggerCount = new Map<Keyword, number>();
  for (const e of elements) {
    for (const t of e.tags.triggers) triggerCount.set(t, (triggerCount.get(t) ?? 0) + 1);
  }
  let trigger = 0;
  for (const n of triggerCount.values()) {
    trigger += TRIGGER_SHARE * Math.min(TRIGGER_GROUP_CAP, (n * (n - 1)) / 2);
  }

  // Overlay term: any curated entry whose both endpoints are reachable (empty in v1).
  let overlay = 0;
  for (const o of CURATED_OVERLAY) {
    if (byHash.has(o.fromHash) && byHash.has(o.toHash)) overlay += o.weight;
  }

  return chain + trigger + overlay;
}
