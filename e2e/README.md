# e2e

Playwright smoke test for the Phase 1 happy path.

## Prereqs

```bash
cd e2e
npm install
npx playwright install chromium
```

Both servers must be up:

```bash
# Terminal 1
cd server && uv run python -m cells_interlinked

# Terminal 2
cd web && npm run dev
```

## Run

```bash
node smoke.mjs                       # Chromium against localhost:3001
ENGINE=webkit node smoke.mjs         # Safari engine — catches Safari-only bugs
BASE=http://other:3001 node smoke.mjs
VERBOSE=1 node smoke.mjs             # log every console + relevant network event

# Diagnostic: timing of every SSE event (proves no buffering)
node sse-timing.mjs
```

Run against both engines before shipping anything that touches the live
interrogation page or the SSE consumer — Chromium tolerates a lot that
WebKit does not (e.g. the unbatched `cells: [...s.cells, ...new]` spread
that locked Safari up at ~40s before the activation buffer was added).

## What it does

1. Loads `/`, screenshots landing.
2. Clicks BEGIN INTERROGATION → picker.
3. Asserts BEGIN button is in the viewport (no scroll required).
4. Selects the canonical introspection probe via the catalog dropdown.
5. Clicks BEGIN, asserts the warming-up overlay appears.
6. Waits up to 120s for the first streamed token.
7. Waits up to 3min for auto-navigation to `/verdict/[runId]`.
8. Asserts the caveats panel is rendered and feature data is present.
9. Reports total page errors + console errors. Non-zero = failure.

Screenshots land in `e2e/screenshots/` (gitignored).
