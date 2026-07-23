import { expect, it } from "vitest";

import type { Build } from "@/lib/types";
import type { Lookup } from "@/lib/validation/types";
import { subclassRules } from "@/lib/validation/subclass";

function run(build: Build, lookup: Partial<Lookup>): string[] {
  return subclassRules.flatMap((r) => r(build, lookup as Lookup)).map((v) => v.code);
}

const base: Build = {
  subclass: { aspectHashes: [], fragmentHashes: [] },
  weapons: [],
  armor: { pieces: [], setBonuses: [], statPriorities: [], modHashes: [] },
  artifact: { selectedPerkHashes: [] },
  constraints: [],
};

const lookup: Partial<Lookup> = {
  aspect: (h) =>
    ({ 1: { hash: 1, element: "void", fragmentSlots: 2 }, 2: { hash: 2, element: "arc", fragmentSlots: 1 } } as never)[h],
  fragment: (h) => ({ 10: { hash: 10, element: "void" }, 11: { hash: 11, element: "arc" } } as never)[h],
};

it("is silent when subclass is not engaged", () => {
  expect(run(base, lookup)).toEqual([]);
});

it("flags fewer than 2 aspects once engaged", () => {
  const b = { ...base, subclass: { ...base.subclass, element: "void" as const, aspectHashes: [1], fragmentHashes: [] } };
  expect(run(b, lookup)).toContain("ASPECT_UNDERFILLED");
});

it("flags more than 2 aspects", () => {
  const b = { ...base, subclass: { ...base.subclass, element: "void" as const, aspectHashes: [1, 1, 1], fragmentHashes: [] } };
  expect(run(b, lookup)).toContain("ASPECT_OVER_LIMIT");
});

it("flags fragments over/under the granted slots", () => {
  const over = { ...base, subclass: { ...base.subclass, element: "void" as const, aspectHashes: [1], fragmentHashes: [10, 10, 10] } };
  expect(run(over, lookup)).toContain("FRAGMENT_OVER_CAP");
  const under = { ...base, subclass: { ...base.subclass, element: "void" as const, aspectHashes: [1], fragmentHashes: [] } };
  expect(run(under, lookup)).toContain("FRAGMENT_UNDERFILLED");
});

it("flags element mismatch on aspects and fragments", () => {
  const b = { ...base, subclass: { ...base.subclass, element: "void" as const, aspectHashes: [2], fragmentHashes: [11] } };
  const codes = run(b, lookup);
  expect(codes.filter((c) => c === "ELEMENT_MISMATCH")).toHaveLength(2);
});
