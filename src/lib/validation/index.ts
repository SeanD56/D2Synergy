import type { Build } from "@/lib/types";

import type { Lookup, Rule, ValidationResult } from "./types";
import { subclassRules } from "./subclass";
import { weaponRules } from "./weapons";
import { armorRules } from "./armor";
import { artifactRules } from "./artifact";

export { createLookup } from "./lookup";
export type {
  Lookup,
  Rule,
  Violation,
  ValidationResult,
  ViolationCategory,
  ViolationCode,
  ViolationSubject,
} from "./types";

/** Every hard rule, across all domains. */
export const ALL_RULES: Rule[] = [
  ...subclassRules,
  ...weaponRules,
  ...armorRules,
  ...artifactRules,
];

/**
 * Run every rule over the build and aggregate violations.
 * `valid` is true iff there are no `game`-category violations.
 */
export function validateBuild(
  build: Build,
  lookup: Lookup,
  rules: readonly Rule[] = ALL_RULES,
): ValidationResult {
  const violations = rules.flatMap((rule) => rule(build, lookup));
  return {
    valid: !violations.some((v) => v.category === "game"),
    violations,
  };
}
