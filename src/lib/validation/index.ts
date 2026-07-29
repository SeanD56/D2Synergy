import type { Build } from "@/lib/types";

import type { Lookup, Rule, ValidationResult } from "./types";
import { subclassRules } from "./subclass";
import { weaponRules } from "./weapons";
import { armorRules } from "./armor";
import { artifactRules } from "./artifact";

export { createLookup } from "./lookup";
export { columnsFor } from "./weapons";
export {
  buildCapacityModel,
  evaluate as evaluateArtifactCapacity,
  canAdd as canAddArtifactPerk,
} from "./artifact-capacity";
export type { CapacityModel, Capacity } from "./artifact-capacity";
// Mod capacity oracle (SP3b slice 2c). Named symmetrically with the artifact oracle above,
// but the structures are NOT interchangeable — artifact sockets are nested/upward-closed,
// mod sockets are categorical (see mod-capacity.ts).
export {
  ARMOR_ENERGY_CAPACITY,
  buildModCapacityModel,
  modCapacityModelForPiece,
  evaluateModCapacity,
  canAddMod,
} from "./mod-capacity";
export {
  GENERAL_MOD_CATEGORIES,
  SLOT_SPECIFIC_SOCKET_COUNT,
  canonicalArmorModLayout,
  canonicalModCapacityModel,
} from "./mod-capacity";
export type { ModCapacityModel, ModCapacity, ModSocket, PlaceableMod } from "./mod-capacity";
export { SET_PIECE_BUDGET, targetPlanProblems } from "./set-plan";
export type { TargetPlanProblem } from "./set-plan";
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
