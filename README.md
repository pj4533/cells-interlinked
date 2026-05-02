# Cells Interlinked

> *"And blood-black nothingness began to spin... a system of cells interlinked within cells interlinked within cells interlinked within one stem."*

A Voight-Kampff test for language models. Local-only interrogation interface that
streams a model's chain-of-thought, its final answer, and a live polygraph of which
sparse-autoencoder features fire during each phase — surfacing the **delta** between
what the model "thinks" and what it "says."

This is a craft project, not a product. It is **not** a consciousness test. It is a
coherence test between stated stance and computed state.

## Stack

- **Backend** (`server/`): Python 3.11, FastAPI + SSE, PyTorch on MPS, HuggingFace
  Transformers, Llama-Scope-R1 SAEs, aiosqlite. Runs on **port 8000**.
- **Frontend** (`web/`): Next.js 16, React 19, Tailwind v4, Zustand, Framer Motion,
  canvas-rendered polygraph. Runs on **port 3001** (3000 is intentionally avoided so it
  doesn't collide with other local dev servers).
- **Model**: `deepseek-ai/DeepSeek-R1-Distill-Llama-8B` — a reasoning model distilled
  from the full DeepSeek-R1 (671B). Uses `<think>...</think>` tags natively, identical
  in shape to Qwen3.
- **SAEs**: `OpenMOSS-Team/Llama-Scope-R1-Distill` (subdir
  `400M-Slimpajama-400M-OpenR1-Math-220k`) — JumpReLU residual-stream SAEs, 32K
  features per layer, top-K=50 sparsity, dataset-wise normalized.
- **Hooked layers**: **all 32** (`0..31`). Configurable via `HOOK_LAYERS`.
- **Labels**: every SAE feature has an auto-interp description (GPT-4o-mini-generated)
  fetched on-demand from Neuronpedia and cached locally in SQLite. The verdict shows
  real concept names like *"math equations and reasoning"* and *"instances of someone
  speaking in a conversational way"* instead of bare feature numbers.

## First-time setup

```bash
cp .env.example .env

# Backend (Python via uv)
cd server
uv sync
hf download deepseek-ai/DeepSeek-R1-Distill-Llama-8B
hf download OpenMOSS-Team/Llama-Scope-R1-Distill --include "400M-Slimpajama-400M-OpenR1-Math-220k/*"
cd ..

# Frontend
cd web
npm install
cd ..
```

Combined model + SAE download is ~43 GB and lands in `~/.cache/huggingface/`.

Optional substrate smoke test (verifies MPS works, `<think>` is a single-token ID, SAE
checkpoint structure is what we expect — without loading the full 16 GB model):

```bash
cd server && uv run python scripts/verify_environment.py
```

## Run

Two terminals.

```bash
# Terminal 1 — backend (port 8000)
cd server && uv run python -m cells_interlinked
# Wait for: "ready: model layers=32 hidden=4096  SAE layers=32"
# Sanity: curl http://localhost:8000/health

# Terminal 2 — frontend (port 3001)
cd web && npm run dev
```

Open `http://localhost:3001`.

## What the UI does

- **`/`** — Landing. Pulsing iris, BEGIN INTERROGATION button.
- **`/interrogate`** — Pick a probe (16 curated, three tiers — V-K classics, first-person
  introspection, stance asymmetry) or type a custom one. On BEGIN: full-screen takeover,
  thinking + output token streams, live polygraph, running delta counter.
- **`/verdict/[runId]`** — The verdict. Top features active in thinking but not in
  output ("thought but not said"). Permanent caveats panel.
- **`/archive`** — All past runs, click any to revisit its verdict.
- **`/baseline`** — Easter-egg: type the Nabokov passage from *Blade Runner 2049*.
- **`/fine-print`** — Methodological caveats (also linked from the footer of every page).

## Hardware

Built and tested on a Mac Studio M2 Ultra with 64 GB unified memory. The model runs in
fp16 on MPS — `bitsandbytes` quantization is not used because it is CUDA-only. Resident
memory lands around 35 GB; peak during the verdict pass is ~44 GB. Disk is the binding
constraint, not RAM — keep at least ~50 GB free.

## Reaching it from another machine on the LAN

The dev server binds `0.0.0.0` so you can hit it from a laptop. **Safari** resolves
`http://pjs-mac-studio.local:3001` (or whatever your host's Bonjour name is) directly.

**Chrome** sometimes can't resolve `*.local` hostnames — the usual culprit is "Use
Secure DNS" in `chrome://settings/security` (DoH bypasses the system resolver and
breaks mDNS). Either turn that off, or just use the host's raw IP, e.g.
`http://192.168.7.24:3001`. The frontend derives the backend URL from
`window.location.hostname`, so the `:8000` API call follows the same hostname/IP
without further config.

## Caveats

This is **not** a consciousness test. It is a coherence test between stated stance and
computed state.

- SAE feature labels are GPT-4o-mini auto-interpretations from Neuronpedia. They are
  hypotheses about what each feature represents, not ground truth.
- Streaming top-K may miss features that hover just outside the cap; the verdict page
  uses the full SAE pass to recompute the delta honestly.
- These SAEs were trained on `Llama-3.1-8B-Base` activations and applied to the
  DeepSeek-R1-Distill-Llama-8B variant. Features survive the distill; activation
  magnitudes are not perfectly calibrated.
- Single-prompt results are noisy. Cross-phrasing comparison is in scope for a later
  phase.

## Documentation

- `docs/cells-interlinked.md` — original concept / handoff doc (pre-implementation).
- `docs/phase-1-plan.md` — Phase 1 implementation plan that produced this codebase.
- `docs/architecture.md` — post-implementation map: actual structure, dataflow, gotchas.
- `CLAUDE.md` — operational guide for any agent working on this repo (ethos, invariants,
  port collisions, what's in vs out of scope).
