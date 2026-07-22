/**
 * Keyword tagging seam.
 *
 * Phase 0 defines the `Tagger` contract here and an `emptyTagger` so
 * `transform.ts` can stay decoupled from the (larger) keyword vocabulary. The
 * real vocabulary + produce/consume heuristics are implemented in this file in
 * a later step and injected into the transform; the transform never hardcodes
 * keyword logic.
 */

import type { Element, KeywordTags } from "../../src/lib/types";

/** Text + element context handed to a tagger for one entity. */
export interface TagInput {
  /** Concatenated descriptive text (item + referenced sandbox perks). */
  text: string;
  /** Element context, when the entity is element-specific. */
  element?: Element;
}

/** Produces normalized synergy tags from an entity's descriptive text. */
export type Tagger = (input: TagInput) => KeywordTags;

/** A tagger that emits no tags — the neutral default / test fixture. */
export const emptyTagger: Tagger = (input) => ({
  produces: [],
  consumes: [],
  triggers: [],
  element: input.element,
});

/**
 * Seed keyword vocabulary: keyword id → surface phrases scanned in text.
 * Frozen game ⇒ this is a one-time investment. Later phases blend the
 * community Clarity dataset for authoritative descriptions.
 */
export const KEYWORD_VOCABULARY: Record<string, string[]> = {
  volatile: ["volatile"],
  jolt: ["jolt", "jolted"],
  blind: ["blind", "blinded", "blinding"],
  scorch: ["scorch", "scorched"],
  ignition: ["ignition", "ignite", "ignited"],
  radiant: ["radiant"],
  restoration: ["restoration"],
  cure: ["cure", "cured"],
  devour: ["devour"],
  invisibility: ["invisible", "invisibility"],
  woven_mail: ["woven mail"],
  tangle: ["tangle"],
  unravel: ["unravel", "unraveling", "unraveled"],
  suspend: ["suspend", "suspended"],
  slow: ["slow", "slowed"],
  freeze: ["freeze", "frozen"],
  shatter: ["shatter"],
  stasis_crystal: ["stasis crystal"],
  frost_armor: ["frost armor"],
  amplified: ["amplified"],
  ionic_trace: ["ionic trace"],
  firesprite: ["firesprite"],
  overshield: ["overshield"],
  weaken: ["weaken", "weakened"],
  suppress: ["suppress", "suppressed"],
  cure_pickup: ["orb of power", "orbs of power"],
};

/** Trigger vocabulary: what causes an effect. */
export const TRIGGER_VOCABULARY: Record<string, string[]> = {
  ability_kill: ["ability kill", "ability final blow"],
  grenade: ["grenade"],
  melee: ["melee"],
  finisher: ["finisher"],
  weapon_kill: ["weapon kill", "weapon final blow"],
  precision_kill: ["precision"],
  pickup_orb: ["orb of power", "orbs of power"],
};

/** Sentence cues that a keyword is being *produced* (applied/created/granted). */
const PRODUCER_CUE =
  /\b(make|makes|making|cause|causes|causing|appl(?:y|ies|ying)|create|creates|creating|grant|grants|granting|gain|gains|become|becomes|becoming|emit|emits|generat|unleash|inflict|inflicts)\b/;

/** Sentence cues that a keyword is being *consumed* (relied upon / spent). */
const CONSUMER_CUE =
  /\b(while|whilst|when|with|consume|consumes|consuming|against|benefit|benefits|empowered|already|spend|spends)\b/;

/**
 * Build a keyword tagger that scans descriptive text against the seed
 * vocabulary and heuristically splits producer vs consumer usage per sentence.
 * This is the load-bearing substrate for the synergy engine; the curated
 * weighting/combo overlay layers on in Phase 2.
 */
export function createKeywordTagger(): Tagger {
  return ({ text, element }) => {
    const produces = new Set<string>();
    const consumes = new Set<string>();
    const triggers = new Set<string>();

    for (const sentence of text.toLowerCase().split(/[.\n;]+/)) {
      const isProducer = PRODUCER_CUE.test(sentence);
      const isConsumer = CONSUMER_CUE.test(sentence);

      for (const [keyword, phrases] of Object.entries(KEYWORD_VOCABULARY)) {
        if (!phrases.some((phrase) => sentence.includes(phrase))) continue;
        // Ambiguous phrasing defaults to "produces" — descriptions usually
        // describe an effect being applied, not merely relied upon.
        if (isProducer || !isConsumer) produces.add(keyword);
        if (isConsumer) consumes.add(keyword);
      }
      for (const [trigger, phrases] of Object.entries(TRIGGER_VOCABULARY)) {
        if (phrases.some((phrase) => sentence.includes(phrase))) triggers.add(trigger);
      }
    }

    return {
      produces: [...produces],
      consumes: [...consumes],
      triggers: [...triggers],
      element,
    };
  };
}
