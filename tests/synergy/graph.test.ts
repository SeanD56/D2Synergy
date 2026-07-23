import { describe, expect, it } from "vitest";

import { EMPTY_TAGS } from "@/lib/types";
import type { BuildElement } from "@/lib/synergy/types";
import { matchChains, triggerSynergies } from "@/lib/synergy/graph";

const el = (hash: number, over: Partial<typeof EMPTY_TAGS>): BuildElement => ({
  hash, source: `e:${hash}`, tags: { ...EMPTY_TAGS, ...over },
});

describe("matchChains", () => {
  it("weights successive chains in a keyword 1, 2, 3 (quadratic depth)", () => {
    const els = [
      el(1, { produces: ["volatile"] }),
      el(2, { produces: ["volatile"] }),
      el(3, { consumes: ["volatile"] }),
      el(4, { consumes: ["volatile"] }),
    ];
    const { synergies } = matchChains(els);
    expect(synergies.map((s) => s.weight).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("applies the element-alignment multiplier only when both ends align", () => {
    const els = [
      el(1, { produces: ["volatile"], element: "void" }),
      el(2, { consumes: ["volatile"], element: "void" }),
    ];
    expect(matchChains(els, "void").synergies[0].weight).toBe(1.5);
    expect(matchChains(els, "arc").synergies[0].weight).toBe(1);
    expect(matchChains(els).synergies[0].weight).toBe(1);
  });

  it("never pairs a produce+consume element with itself, nor flags it as a gap", () => {
    const els = [el(1, { produces: ["restoration"], consumes: ["restoration"] })];
    const r = matchChains(els);
    expect(r.synergies).toEqual([]);
    expect(r.unusedProducers).toEqual([]);
    expect(r.unmetConsumers).toEqual([]);
  });

  it("reports leftover producers/consumers as gaps", () => {
    const producerOnly = matchChains([el(1, { produces: ["jolt"] })]);
    expect(producerOnly.unusedProducers).toEqual(["jolt"]);
    expect(producerOnly.unmetConsumers).toEqual([]);
    const consumerOnly = matchChains([el(2, { consumes: ["jolt"] })]);
    expect(consumerOnly.unmetConsumers).toEqual(["jolt"]);
    expect(consumerOnly.unusedProducers).toEqual([]);
  });
});

describe("triggerSynergies", () => {
  it("caps pairs per trigger group at TRIGGER_GROUP_CAP", () => {
    const els = [1, 2, 3, 4].map((h) => el(h, { triggers: ["grenade"] }));
    const out = triggerSynergies(els); // C(4,2)=6 possible, capped at 3
    expect(out.length).toBe(3);
    expect(out.every((s) => s.via === "trigger:grenade" && s.weight === 0.5)).toBe(true);
  });
});
