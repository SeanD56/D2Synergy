import { describe, expect, it } from "vitest";
import { nonPowerAmmoInfeasible } from "@/lib/solver/weapons";

describe("nonPowerAmmoInfeasible", () => {
  it("false when fewer than both non-power slots are decided", () => {
    expect(nonPowerAmmoInfeasible([{ slot: "kinetic", ammoType: "primary" }])).toBe(false);
  });
  it("true when kinetic + energy are both decided and both Primary", () => {
    expect(nonPowerAmmoInfeasible([
      { slot: "kinetic", ammoType: "primary" },
      { slot: "energy", ammoType: "primary" },
    ])).toBe(true);
  });
  it("false when one non-power slot is Special", () => {
    expect(nonPowerAmmoInfeasible([
      { slot: "kinetic", ammoType: "primary" },
      { slot: "energy", ammoType: "special" },
    ])).toBe(false);
  });
  it("ignores Power slots", () => {
    expect(nonPowerAmmoInfeasible([
      { slot: "kinetic", ammoType: "primary" },
      { slot: "power", ammoType: "heavy" },
    ])).toBe(false);
  });
});
