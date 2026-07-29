<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Active work

D2Synergy is a Destiny 2 buildcrafting engine: a static-ingested dataset (`data/*.json`) feeding a rules-based synergy engine and a beam-search solver that completes partially-pinned builds.

- **RESUME HERE → `docs/HANDOFF.md`.** It is the single resume point: current phase, task status, test baseline, and the next action. Read it before touching code.
- Active line of work: **Phase 2 · SP3b** (solver dimensions, delivered in slices) plus the **Next.js recommender UI** in `src/app`. Work happens on `main` unless the handoff says otherwise.
- Specs and plans live in `docs/superpowers/specs/` and `docs/superpowers/plans/`. When a plan and its spec disagree, **the plan wins** — it carries the reviewed code.
- Verify with `npx vitest run && npx tsc --noEmit && npx eslint scripts src tests`, and `npx next build` for UI changes. The handoff records the expected pass count; anything less is a regression.
