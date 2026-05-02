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
  calls except for Neuronpedia label lookups (cached locally; no telemetry sent).
- **MPS backend, fp16.** `bitsandbytes` is CUDA-only and will not run here — do not
  reach for `int8` / `4bit` quantization. If memory pressure becomes a problem the
  fallback is MLX-converted weights or attention slicing, not bnb.
- **Disk awareness.** Model weights (~15 GB) + 32 Llama-Scope-R1 SAEs (~28 GB) live in
  `~/.cache/huggingface/` for ~43 GB total. The box has crashed before from memory
  pressure spilling onto a near-full disk. Monitor disk before long runs.
- **Port 3000 is taken** by another local dev server (Drift, running under Docker). The
  web app is configured for **port 3001** (`web/package.json` `dev` script). The backend
  is on **port 8000**. Do not reintroduce a 3000 default.

---

## Stack (locked for Phase 1)

| Piece | Choice | Notes |
|---|---|---|
| Model | `deepseek-ai/DeepSeek-R1-Distill-Llama-8B` | 32 layers, hidden 4096. Reasoning model — `<think>...</think>` are single token IDs (128013 / 128014). Chat template auto-injects `<think>` after the assistant prompt. |
| SAEs | `OpenMOSS-Team/Llama-Scope-R1-Distill` (subdir `400M-Slimpajama-400M-OpenR1-Math-220k`) | Residual-stream, 32K features per layer, JumpReLU activation, top-K=50 sparsity, dataset-wise normalized. Same SAE family hosted on Neuronpedia under `{layer}-llamascope-slimpj-openr1-res-32k`. |
| Hooked layers | **All 32** (`0..31`). Configurable via `HOOK_LAYERS` env. |
| Feature labels | Auto-interp by GPT-4o-mini, fetched from Neuronpedia per `(layer, feature_id)` and cached in SQLite. Empty string = no label. |
| Streaming policy | per-token live top-K (cheap) | full SAE decomposition only at phase boundary (honest verdict). |
| Backend | FastAPI + SSE on port 8000 | one-way streaming, custom autoregressive loop on `model.forward(use_cache=True)`, NOT `model.generate()` and NOT NNsight. |
| Frontend | Next.js 16 + React 19 + Tailwind v4 + Zustand + Framer Motion | port 3001, canvas-rendered polygraph. |
| Persistence | SQLite via `aiosqlite` | one row per run, JSON blobs for arrays; separate `feature_labels` table caches Neuronpedia lookups. |

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
# Wait for: "ready: model layers=32 hidden=4096  SAE layers=32"
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
hf download deepseek-ai/DeepSeek-R1-Distill-Llama-8B
hf download OpenMOSS-Team/Llama-Scope-R1-Distill --include "400M-Slimpajama-400M-OpenR1-Math-220k/*"
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
   hooks at the 32 chosen layers capture the **last-position residual** each step. We do
   NOT use `model.generate()` (no per-step emission control) and we do NOT use NNsight.
2. **Phase detection is by token ID, not string match.** `<think>` (128013) and
   `</think>` (128014) are stable single-token IDs in DeepSeek-R1-Distill-Llama-8B.
   BPE may split a string match across emissions. IDs are cached on model load;
   substring matching is the documented fallback if the tokenizer ever splits them.
   Note the chat template auto-injects `<think>` after the assistant prompt, so
   PhaseTracker starts in `THINKING` rather than waiting for an open-think token.
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
6. **SAE format is JumpReLU + dataset-wise normalized.** `sae_runner.LlamaScopeR1SAE`
   reads the per-layer `config.json` and `sae_weights.safetensors` directly. The
   crucial step: divide the residual by `dataset_average_activation_norm.{hook}`
   before encoding (otherwise the JumpReLU threshold suppresses ~everything).
   Thresholds are stored as `log_jumprelu_threshold` and exponentiated at load time.
   Encoder is `[d_sae, d_model]`, decoder is `[d_model, d_sae]` — both transposed at
   load time so we can do `x @ W` directly in the hot path.
7. **Caveats panel is always visible** on `/verdict` — not behind a toggle. Same for
   the `/fine-print` page accessible via the footer link.
8. **Feature labels come from Neuronpedia.** After the verdict pass, the backend
   collects every `(layer, feature_id)` referenced in the result and asynchronously
   fetches `description` from `https://www.neuronpedia.org/api/feature/{model_id}/{layer}-llamascope-slimpj-openr1-res-32k/{feature_id}`.
   Hits and explicit misses (empty string) are cached in the `feature_labels` SQLite
   table so subsequent runs are instant. The cache lives at `server/data/probes.sqlite`.

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
    model_loader.py        DeepSeek-R1-Distill-Llama-8B fp16 on MPS, ModelBundle, special-token ID cache
    sae_runner.py          LlamaScopeR1SAE + SAEManager (JumpReLU, dataset-wise norm)
    labels.py              Neuronpedia label fetcher + SQLite cache
    phase_tracker.py       PhaseTracker (token-ID-based) + ResidualRing
    generation_loop.py     custom autoregressive loop + ResidualHooks + sampling
    verdict.py             phase-boundary full SAE pass + delta computation
  storage/db.py            aiosqlite schema (`probes` + `feature_labels` tables, JSON blobs)
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
  and had to be restarted. The cached weights (~43 GB) are the largest single sink.
- **Port 3000 collision** with the user's Drift Docker container. Web is on 3001.
- **Safari SSE buffering.** Without a 2 KB padding comment at the start of the SSE
  stream, Safari/Firefox hold every event until end-of-run; the live polygraph appears
  to "flash by" in the final second. See `routes_stream.py`.
- **Activation array O(n²).** Per-event `cells: [...s.cells, ...new]` in Zustand was
  spreading the entire array per event and locked Safari up at ~40 s. Fixed with a
  module-level buffer flushed at 10 Hz; see `web/lib/store.ts`.
- **JumpReLU thresholds suppress everything if you skip dataset-wise normalization.**
  Llama-Scope-R1 was trained on dataset-normalized residuals; feeding raw residuals
  into the encoder produces near-zero activations because almost nothing clears the
  threshold.
