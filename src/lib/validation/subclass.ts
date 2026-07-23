import type { Build } from "@/lib/types";

import type { Rule, Violation } from "./types";

export const MAX_ASPECTS = 2;

/** Subclass is "engaged" once the user has committed to building it. */
function engaged(build: Build): boolean {
  const s = build.subclass;
  return Boolean(
    s.element ||
      s.superHash !== undefined ||
      s.aspectHashes.length > 0 ||
      s.fragmentHashes.length > 0,
  );
}

const aspectCount: Rule = (build) => {
  if (!engaged(build)) return [];
  const n = build.subclass.aspectHashes.length;
  const out: Violation[] = [];
  if (n > MAX_ASPECTS) {
    out.push({
      code: "ASPECT_OVER_LIMIT",
      category: "game",
      message: `A subclass allows at most ${MAX_ASPECTS} aspects; ${n} selected.`,
      subject: { kind: "subclass" },
    });
  }
  if (n < MAX_ASPECTS) {
    out.push({
      code: "ASPECT_UNDERFILLED",
      category: "game",
      message: `Use all ${MAX_ASPECTS} aspect slots; only ${n} selected.`,
      subject: { kind: "subclass" },
    });
  }
  return out;
};

const fragmentCount: Rule = (build, lookup) => {
  const { aspectHashes, fragmentHashes } = build.subclass;
  if (aspectHashes.length === 0) return [];
  const slots = aspectHashes.reduce(
    (sum, h) => sum + (lookup.aspect(h)?.fragmentSlots ?? 0),
    0,
  );
  const n = fragmentHashes.length;
  const out: Violation[] = [];
  if (n > slots) {
    out.push({
      code: "FRAGMENT_OVER_CAP",
      category: "game",
      message: `Equipped aspects grant ${slots} fragment slots; ${n} selected.`,
      subject: { kind: "subclass" },
    });
  }
  if (n < slots) {
    out.push({
      code: "FRAGMENT_UNDERFILLED",
      category: "game",
      message: `Fill all ${slots} fragment slots; only ${n} selected.`,
      subject: { kind: "subclass" },
    });
  }
  return out;
};

const elementConsistency: Rule = (build, lookup) => {
  const element = build.subclass.element;
  if (!element) return [];
  const out: Violation[] = [];
  for (const h of build.subclass.aspectHashes) {
    const aspect = lookup.aspect(h);
    if (aspect && aspect.element !== element) {
      out.push({
        code: "ELEMENT_MISMATCH",
        category: "game",
        message: `Aspect "${aspect.name}" is ${aspect.element}, not ${element}.`,
        subject: { kind: "aspect", hash: h },
      });
    }
  }
  for (const h of build.subclass.fragmentHashes) {
    const fragment = lookup.fragment(h);
    if (fragment && fragment.element !== element) {
      out.push({
        code: "ELEMENT_MISMATCH",
        category: "game",
        message: `Fragment "${fragment.name}" is ${fragment.element}, not ${element}.`,
        subject: { kind: "fragment", hash: h },
      });
    }
  }
  return out;
};

export const subclassRules: Rule[] = [aspectCount, fragmentCount, elementConsistency];
