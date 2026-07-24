import { describe, expect, it } from "vitest";

import { createKeywordTagger } from "../../scripts/ingest/keywords";

const tag = createKeywordTagger();

describe("champion-stun extraction", () => {
  it("tags anti-barrier phrasing as barrier", () => {
    const tags = tag({ text: "Anti-Barrier: Your Sniper Rifles pierce the shields of Barrier Champions." });
    expect(tags.championStuns).toEqual(["barrier"]);
  });

  it("tags overload and unstoppable", () => {
    expect(tag({ text: "Overload Rounds: your weapon overloads targets." }).championStuns)
      .toEqual(["overload"]);
    expect(tag({ text: "Unstoppable Pulse: charged shots stagger unstoppable combatants." }).championStuns)
      .toEqual(["unstoppable"]);
  });

  it("dedupes and preserves vocabulary order across sentences", () => {
    const tags = tag({
      text: "Anti-Barrier: pierce the shields. More anti-barrier text. Unstoppable rounds too.",
    });
    expect(tags.championStuns).toEqual(["barrier", "unstoppable"]);
  });

  it("never leaks champion phrases into produces/consumes/triggers", () => {
    const tags = tag({ text: "Anti-Barrier: pierce the shields of Barrier Champions." });
    expect(tags.produces).toEqual([]);
    expect(tags.consumes).toEqual([]);
    expect(tags.triggers).toEqual([]);
  });

  it("omits the field entirely when no champion phrase is present", () => {
    const tags = tag({ text: "Grants restoration to nearby allies." });
    expect(tags.championStuns).toBeUndefined();
    expect("championStuns" in tags).toBe(false);
  });

  it("still tags ordinary keywords alongside a champion phrase", () => {
    const tags = tag({ text: "Anti-Barrier: pierce the shields. Final blows make targets volatile." });
    expect(tags.championStuns).toEqual(["barrier"]);
    expect(tags.produces).toContain("volatile");
  });
});
