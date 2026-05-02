# Cells Interlinked — agent guide

A local Voight-Kampff interrogation interface for an LLM. Streams chain-of-thought, final
answer, and a polygraph of which sparse-autoencoder features fire during each phase.
The "verdict" is the **delta** between features active in `<think>` vs features active in
the model's spoken output — what the model "thought but didn't say."

This file is the operational guide for any future agent (or returning user) working on
this repo. The high-level concept doc lives at `docs/cells-interlinked.md`. The Phase 1
implementation plan that produced this codebase lives at `docs/phase-1-plan.md`. A
post-implementation architecture map lives at `docs/architecture.md`.

---

## Project ethos (do not violate)

- **Craft over feature count.** Built for the joy of it, not as a product or paper.
  Default to *less* surface area. When tempted to add a comparison view / extra
  experiment / fancy panel, ask first.
- **Methodological honesty is non-negotiable.** Every verdict screen carries a
  permanent visible disclaimer. Never let the UI over-claim what an SAE-feature delta
  means. This is a stated-vs-computed coherence probe, **not** a consciousness test.
- **Easter-egg restraint.** ~one per minute of average use, max. Eggs reward attention;
  they never announce themselves and never break the interrogation flow.
- **Quiet mastery aesthetic.** The probe data is the point, not spinner animations.

---

## Hardware + environment constraints

- **Mac Studio M2 Ultra, 64GB unified memory.** All work is local and offline. No cloud
  calls, no telemetry.
- **MPS backend, fp16.** `bitsandbytes` is CUDA-only and will not run here — do not
  reach for `int8` / `4bit` quantization. If memory pressure becomes a problem the
  fallback is MLX-converted weights or attention slicing, not bnb.
- **Disk is tight.** The Qwen3-8B weights (~15GB) and Qwen-Scope SAEs (~26GB) live in
  `~/.cache/huggingface/`. Combined with model load + SAE load, the box has crashed
  once already from memory pressure spilling onto a near-full disk. Monitor disk before
  long runs.
- **Port 3000 is taken** by another local dev server (Drift, running under Docker). The
  web app is configured for **port 3001** (`web/package.json` `dev` script). The backend
  is on **port 8000**. Do not reintroduce a 3000 default.

---

## Stack (locked for Phase 1)

| Piece | Choice | Notes |
|---|---|---|
| Model | `Qwen/Qwen3-8B` (Instruct) | 36 layers, hidden 5120. Hybrid thinking via `enable_thinking=True` on the chat template. |
| SAEs | `Qwen/SAE-Res-Qwen3-8B-Base-W64K-L0_50` | Qwen-Scope, residual-stream, 64K features per layer, top-50 sparsity. **Trained on Base, applied to Instruct** — features survive but magnitudes are not calibrated. |
| Hooked layers | `{2, 6, 10, 14, 16, 18, 20, 22, 24, 26, 28, 30, 34}` | 13 layers, middle-weighted. Configurable via `HOOK_LAYERS` env. |
| Streaming policy | per-token live top-K (cheap) | full SAE decomposition only at phase boundary (honest verdict). |
| Backend | FastAPI + SSE on port 8000 | one-way streaming, custom autoregressive loop on `model.forward(use_cache=True)`, NOT `model.generate()` and NOT NNsight. |
| Frontend | Next.js 16 + React 19 + Tailwind v4 + Zustand + Framer Motion | port 3001, canvas-rendered polygraph. |
| Persistence | SQLite via `aiosqlite` | one row per run, JSON blobs for arrays. |

**Important Next.js note:** the version in `web/node_modules/next` is 16.2.4 — newer than
most training data. Read the relevant guide in `node_modules/next/dist/docs/` before
writing frontend code. See `web/AGENTS.md` (re-exported as `web/CLAUDE.md`).

---

## How to run

Two terminals.

```bash
# Terminal 1 — backend
cd server
uv run python -m cells_interlinked
# Wait for: "ready: model layers=36 hidden=5120  SAE layers=13"
# Health check: curl http://localhost:8000/health

# Terminal 2 — frontend
cd web
npm run dev
# Open http://localhost:3001
```

First-time-ever setup (already done on this box):

```bash
cp .env.example .env
cd server && uv sync
hf download Qwen/Qwen3-8B
hf download Qwen/SAE-Res-Qwen3-8B-Base-W64K-L0_50
cd ../web && npm install
```

The day-one substrate smoke-test (verifies MPS, Qwen3 think-token IDs, and SAE
checkpoint structure without loading the full model) lives at
`server/scripts/verify_environment.py`.

---

## Critical implementation invariants

These exist for hard-won reasons. Don't undo them without thinking.

1. **Custom autoregressive loop.** `pipeline/generation_loop.py` calls
   `model.forward(input_ids, past_key_values=kv, use_cache=True)` step-by-step. Forward
   hooks at the 13 chosen layers capture the **last-position residual** each step. We do
   NOT use `model.generate()` (no per-step emission control) and we do NOT use NNsight.
2. **Phase detection is by token ID, not string match.** `<think>` and `</think>` are
   stable single-token IDs in Qwen3. BPE may split a string match across emissions.
   IDs are cached on model load; substring matching is the documented fallback if the
   tokenizer ever splits them.
3. **SSE event protocol** is a discriminated union (see `web/lib/types.ts` and
   `server/cells_interlinked/api/routes_probe.py`). Event types: `phase_change`,
   `token`, `activation` (one per (token, layer)), `stopped`, `verdict`, `done`,
   `error`, plus `ping` heartbeats during quiet periods. Keep both ends in sync; the
   frontend types file mirrors the backend dataclasses.
4. **One-run-at-a-time.** `RunRegistry` holds an `asyncio.Lock`; only one probe runs
   through the model at a time. The model + SAEs together are too large to swap.
5. **Per-phase residual ring buffers.** Grow in 1024-token chunks (see
   `phase_tracker.ResidualRing`). The verdict pass reads `ring.view` to get
   `[num_tokens, num_layers, d_model]` and runs the **full** SAE encode per layer. This
   is the honest delta; the streaming top-K is just for the live polygraph.
6. **SAE format is auto-detected.** `sae_runner._infer_format()` adapts to plain top-K
   vs JumpReLU at load time so we don't hard-code key names. JumpReLU thresholds are
   applied in `QwenScopeSAE.encode()` if the checkpoint provides them.
7. **Caveats panel is always visible** on `/verdict` — not behind a toggle. Same for
   the `/fine-print` page accessible via the footer link.

---

## What's in scope vs deferred

**Phase 1 (the only thing we ship):** landing → probe picker → live interrogation →
verdict → archive. Plus the `/baseline` Nabokov easter-egg page. Plus the tears-in-rain
404/500. That is the entire surface.

**Deferred to later phases (do not build without explicit ask):**
- Atlas / Sincerity Probe / Cross-Phrasing experiments (the doc's three-experiment
  matrix).
- Comparison view in archive (two probes side-by-side).
- Sound / Vangelis-style audio.
- Owl, chess knight, hidden keyboard chord, Nexus serial scroll.
- Auto-interp labels via LLM (defer to Neuronpedia lookup if/when Qwen-Scope features
  land there; otherwise "feature #N at layer L").
- Anything autoresearch (Phase 2 in `docs/cells-interlinked.md`).

---

## Where things live

```
server/cells_interlinked/
  __main__.py              uvicorn entry
  config.py                env-driven settings (.env at repo root)
  api/
    app.py                 FastAPI factory, lifespan loads model + SAEs
    routes_probe.py        POST /probe, POST /cancel/{id}, GET /probes/{recent,id}
    routes_stream.py       GET /stream/{id} — SSE drain
    runs.py                RunRegistry + per-run asyncio queues / cancel events
  pipeline/
    model_loader.py        Qwen3-8B fp16 on MPS, ModelBundle, special-token ID cache
    sae_runner.py          QwenScopeSAE + SAEManager; format auto-inference
    phase_tracker.py       PhaseTracker (token-ID-based) + ResidualRing
    generation_loop.py     custom autoregressive loop + ResidualHooks + sampling
    verdict.py             phase-boundary full SAE pass + delta computation
  storage/db.py            aiosqlite schema (single `probes` table, JSON blobs)
  scripts/verify_environment.py   day-one substrate smoke test

web/
  app/
    page.tsx                 / (landing)
    interrogate/page.tsx     picker + live interrogation
    verdict/[runId]/page.tsx
    archive/page.tsx
    baseline/page.tsx        Nabokov easter-egg
    fine-print/page.tsx      methodological caveats (linked from footer)
    error.tsx                tears-in-rain 500
    not-found.tsx            "you've never been outside the wall" 404
    components/
      Polygraph.tsx          canvas-rendered V-K timeline
      Iris.tsx               animated SVG iris
      ProbePicker.tsx        16-probe grid + free-text input
      TokenPanes.tsx         thinking (dim) + output (bright)
      DeltaPanel.tsx         running thought-but-not-said counter
      CaveatsPanel.tsx       always-visible disclaimer
      Footer.tsx
  lib/
    sse.ts                   EventSource wrapper, derives API base from window.location
    store.ts                 Zustand: current run, polygraph cells, phase, verdict
    types.ts                 mirrors backend SSE event union
    probes.ts                curated probe library (3 tiers, 16 entries)

docs/
  cells-interlinked.md     original concept / handoff doc (pre-implementation)
  architecture.md          post-implementation map: actual structure, dataflow, gotchas
```

---

## Things that have already burned us

- **Disk space.** A previous session ran out of disk during model load; the system OOM'd
  and had to be restarted. The 41GB of cached weights is the largest single sink.
- **Port 3000 collision** with the user's Drift Docker container. Web is on 3001.
