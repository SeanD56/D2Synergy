import type { Rule, Violation } from "@/lib/validation/types";

import { collectBuildElements } from "./elements";
import { matchChains } from "./graph";

/** Soft `policy` advisories: unused producers and unmet consumers. */
const synergyAdvisories: Rule = (build, lookup) => {
  const elements = collectBuildElements(build, lookup);
  const { unusedProducers, unmetConsumers } = matchChains(elements, build.subclass.element);
  const out: Violation[] = [];

  for (const keyword of unusedProducers) {
    out.push({
      code: "UNUSED_PRODUCER",
      category: "policy",
      message: `You create ${keyword} but nothing in the build consumes it.`,
      subject: { kind: "synergy", keyword },
    });
  }
  for (const keyword of unmetConsumers) {
    out.push({
      code: "UNMET_CONSUMER",
      category: "policy",
      message: `You rely on ${keyword} but nothing in the build produces it.`,
      subject: { kind: "synergy", keyword },
    });
  }
  return out;
};

export const synergyRules: Rule[] = [synergyAdvisories];
