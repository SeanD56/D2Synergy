import type { Build } from "@/lib/types";

import type { Lookup, Rule, ValidationResult } from "./types";

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

/**
 * Run every rule over the build and aggregate violations.
 * `valid` is true iff there are no `game`-category violations.
 */
export function validateBuild(
  build: Build,
  lookup: Lookup,
  rules: readonly Rule[],
): ValidationResult {
  const violations = rules.flatMap((rule) => rule(build, lookup));
  return {
    valid: !violations.some((v) => v.category === "game"),
    violations,
  };
}
