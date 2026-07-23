import { describe, expect, it } from "vitest";

import type { Build } from "@/lib/types";
import { neutralStatFit } from "@/lib/solver/stat-fit";
import type { SolverContext } from "@/lib/solver/types";

const anyBuild = {} as Build;
const anyCtx = {} as SolverContext;

describe("neutralStatFit", () => {
  it("is the v1 stub returning 0 for any build", () => {
    expect(neutralStatFit(anyBuild, anyCtx)).toBe(0);
  });
});
