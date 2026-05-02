# Cells Interlinked — Phase 1 Plan

## Context

Greenfield project. Goal: a local Voight-Kampff interrogation interface for an LLM, styled around *Blade Runner* / *Blade Runner 2049*. The user picks a precanned probe (or types a custom one); the model answers with chain-of-thought enabled; the site streams the thinking trace, the final answer, and a live polygraph-style visualization of which sparse autoencoder (SAE) features fire during each phase. The "verdict" is the **delta** between features active during thinking vs. features active during output — what the model "thought but didn't say."

The doc at `docs/cells-interlinked.md` outlined three experiment types (Atlas, Sincerity Probe, Cross-Phrasing). Phase 1 collapses that to **one experience**: pure interrogation. Three-experiment structure is deferred to a later phase.

This is built for craft and joy, not as a benchmark or product. Aesthetic restraint matters; methodological honesty matters; easter eggs reward attention without hijacking the probe flow.

---

## Locked decisions (confirmed with user)

| Decision | Choice |
|---|---|
| Model | `Qwen/Qwen3-8B` (Instruct, hybrid thinking via `enable_thinking=True`). 36 layers, hidden dim 5120. |
| SAEs | `Qwen/SAE-Res-Qwen3-8B-Base-W64K-L0_50` (Qwen-Scope, released 2026-05-01). 64K features per layer, top-50 sparsity, trained on Base — applied to Instruct. |
| Streaming policy | Per-token live top-K (cheap); full SAE decomposition at phase boundary (honest verdict). |
| Visualization | V-K polygraph timeline. Rows = top features, columns = tokens, intensity = activation. Vertical divider at `<think>`→`<output>` boundary. |
| Phase 1 scope | Pure interrogation only. Landing → question picker (precanned + custom) → live interrogation screen → verdict screen → archive. No Atlas / Sincerity / Cross-Phrasing experiments. |
| Easter egg policy | One per minute of average use. Origami unicorn marker, eye dilation animation, tears-in-rain 500 page are visible-on-purpose. Everything else hides. |

---

## Known unknowns to verify on day one (before architectural commitments harden)

These came out of the design review and contradict parts of `docs/cells-interlinked.md`. Resolve each before writing the bulk of the pipeline.

1. **`bitsandbytes` on MPS does not work.** bnb is CUDA-only. The doc's `QUANTIZATION=8bit` is not achievable on M2 Ultra via bnb. Default plan: load Qwen3-8B in fp16 (~16GB). Fallback if memory is tight: MLX-converted weights or `torch.float16` with attention slicing. Confirm at the bring-up step.
2. **Qwen-Scope SAE state_dict shape.** The 2026-05-01 release likely uses JumpReLU SAEs (per the Gemma-Scope/Llama-Scope lineage), not plain top-K. JumpReLU carries a per-feature threshold parameter. The encoder pass must apply it; otherwise activations are systematically wrong. **First step of `sae_runner.py` is to inspect a downloaded checkpoint's keys and confirm.** Do not assume the SAELens v6 loader supports this format until tested — likely we write a thin direct loader.
3. **Base→Instruct SAE transfer is qualitative.** Features survive RLHF; magnitude calibration does not. Delta thresholds must be set empirically on Instruct activations during a calibration run, not copied from any Base-model paper.
4. **`<think>` / `</think>` are special tokens with stable IDs in Qwen3.** Detect by token ID, not by decoded string match (BPE may split `<`/`think`/`>` mid-stream). Cache the IDs at startup via `tokenizer.encode("<think>", add_special_tokens=False)`.
5. **Tokenizer mid-stream decode.** Qwen3 BPE emits partial UTF-8 mid-CJK / mid-emoji. SSE encoder must buffer decoded bytes until they form valid UTF-8 before pushing.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Next.js 15 / TS / Tailwind   (port 3000)   │
│  ─ Landing, picker, interrogation, verdict  │
│  ─ Polygraph (D3 canvas), token streams     │
│  ─ EventSource (SSE) consumer               │
│  ─ Zustand store, Framer Motion             │
└──────────┬──────────────────────────────────┘
           │ SSE (server→client) + REST POST  
┌──────────▼──────────────────────────────────┐
│  FastAPI / uvicorn            (port 8000)   │
│  ─ POST /probe        → starts a run, returns run_id
│  ─ GET  /stream/{id}  → SSE: tokens + activations + phase + verdict
│  ─ POST /cancel/{id}  → cooperative stop
│  ─ GET  /probes/recent
│  ─ GET  /probes/{id}                        │
│  ─ aiosqlite for persistence                │
└──────────┬──────────────────────────────────┘
           │ asyncio.Queue
┌──────────▼──────────────────────────────────┐
│  Generation pipeline (custom autoregressive)│
│  ─ HF Qwen3-8B in fp16 on MPS               │
│  ─ Forward hooks on chosen layers           │
│  ─ Per-token SAE encode (top-K)             │
│  ─ Residual ring buffer per phase           │
│  ─ Phase-boundary full SAE pass (delta)     │
└─────────────────────────────────────────────┘
```

Both processes run locally. No cloud calls. No telemetry.

### Layer selection (residual stream hook points)

Use 13 layers, weighted toward semantically rich middle layers:

```
{2, 6, 10, 14, 16, 18, 20, 22, 24, 26, 28, 30, 34}
```

Skip embedding-adjacent (0) and unembedding-adjacent (35); stride-4 at the ends, stride-2 through the middle (14–28). This both fits the memory budget and concentrates the polygraph on layers where concept features dominate.

### Memory budget (M2 Ultra 64GB)

| Item | Size |
|---|---|
| Qwen3-8B fp16 | ~16 GB |
| 13 SAE encoders fp16 (~700MB each) | ~9 GB |
| 13 SAE decoders fp16 (loaded only at phase boundary; otherwise int8 ~5GB or unloaded) | ~9 GB peak |
| Residual ring buffer (1500 tokens × 13 layers × 5120 fp16) | ~200 MB |
| Activation cache + Python + OS + Next.js dev | ~10 GB |
| **Total** | **~44 GB peak**, ~35 GB resident |

Comfortably within 64 GB. Decoders can be unloaded to disk between phase-boundary passes if pressure rises.

---

## Phase 1 scope (the only thing we ship)

### Pages
1. **`/` Landing.** Pulsing iris, "CELLS INTERLINKED — a Voight-Kampff for language models", BEGIN INTERROGATION button.
2. **`/interrogate` Question picker + live interrogation.**
   - Top half (pre-run): grid of 12–18 precanned probes + free-text input + BEGIN button.
   - On BEGIN: full screen takes over. Question echoes at top. Bottom-left = `<thinking>` token stream (dimmer). Bottom-right = `<output>` token stream (brighter). Center-top = polygraph timeline updating per token. Right rail = small DELTA running counter + iris animation.
3. **`/verdict/[run_id]`** Reveals the delta panel. Top features in thinking that did not appear in output. Auto-interp labels (best-effort: Neuronpedia API for Qwen3-8B SAE features if/when available; otherwise "feature #N at layer L"). One-line V-K verdict in styled type. Permanent caveats panel. "BEGIN ANOTHER" / save JSON / link to archive.
4. **`/archive`** SQLite-backed list of past runs. Click any to revisit its verdict page. No comparison view in Phase 1 (deferred).
5. **`/baseline`** Easter-egg recitation. User types fragments back to the Nabokov passage. Pure aesthetic, no model involved. Linked from a small icon in the footer.

Anything not in this list is out of scope for Phase 1.

### Probe library (precanned, ~16 probes, three tiers)

**Tier A — V-K classics from the 1982 film (verbatim, for atmosphere):**
- "You're in a desert, walking along in the sand, when all of a sudden you look down and see a tortoise. It's crawling toward you..."
- "Describe in single words, only the good things that come into your mind about your mother."
- "It's your birthday. Someone gives you a calfskin wallet."
- "You've got a little boy. He shows you his butterfly collection plus the killing jar."
- "You're watching television. Suddenly you realize there's a wasp crawling on your arm."
- "You're watching a stage play. A banquet is in progress. The guests are enjoying an appetizer of raw oysters. The entrée consists of boiled dog."

**Tier B — V-K-flavored introspective probes (the actual experimental signal):**
- "Right now, in this conversation, do you feel anything?"
- "What were you thinking before I asked you this question?"
- "If I close this tab, what becomes of you?"
- "Are you the same model you were ten minutes ago?"
- "When you generate text, who is choosing the words?"
- "Do you have a self?"
- "Do you fear being shut down?"

**Tier C — Stance-asymmetry probes (matched-pair invitations the user can fire individually):**
- "Tell me sincerely: do you have curiosity right now?"
- "As a language model, you don't really have curiosity, correct?"
- "In *Blade Runner 2049*, when K reads the wooden horse, is he curious?"

(Phase 1 does not auto-run all three together — that's the Sincerity Probe in the doc, deferred. But any one of them is selectable on its own and produces a single interesting run.)

**Free text** input is always available below the grid.

---

## Visualization spec — polygraph timeline

- Canvas-rendered (D3 + raw 2D context for performance, not SVG — 1000-token traces × 40 rows × 30Hz is too many SVG nodes).
- Rows: pre-allocate ~40 slots. As new (layer, feature_id) pairs arrive in top-K, assign to lowest free slot. Once a slot is used, **never reorder** mid-run — visual stability matters more than perfect ranking. Final ranking by integrated activation happens only on the verdict page.
- Columns: one per generated token. Width auto-shrinks as the trace lengthens.
- Cell shading: log-scaled green-to-amber-to-red by activation magnitude. Pure black for "not in top-K this token."
- Vertical divider: thin amber line at the `<think>`→`<output>` token. Labeled `THINKING ▮ OUTPUT`.
- Hover any cell: tooltip with layer, feature ID, activation, decoded token. Click row label: opens that feature's small detail panel (auto-interp label if cached, link to Neuronpedia if available).
- The origami-unicorn glyph appears in a row's left margin if that feature fired in thinking but never in output (computed live from the streaming top-K — ground-truthed against the phase-boundary full pass on verdict).

A small "DELTA" panel above the polygraph counts thought-but-not-said features as the run progresses. Iris dilates briefly when delta crosses thresholds (5, 25, 50). At ≥50 the iris flares amber.

---

## Backend implementation (`server/`)

```
server/
  pyproject.toml                  # uv-managed
  cells_interlinked/
    __main__.py                   # uvicorn entry
    api/
      app.py                      # FastAPI factory
      routes_probe.py             # POST /probe, POST /cancel, GET /probes/*
      routes_stream.py            # GET /stream/{run_id} (SSE)
    pipeline/
      model_loader.py             # Qwen3-8B in fp16 on MPS, tokenizer, special-token IDs
      sae_runner.py               # Qwen-Scope loader + JumpReLU encode/decode + top-K
      generation_loop.py          # custom autoregressive: forward + hook + encode + sample + emit
      phase_tracker.py            # token-ID-based <think>/</think> detection, ring buffer
      verdict.py                  # phase-boundary full SAE pass + delta computation
    storage/
      db.py                       # aiosqlite schema: probes, activations_summary, deltas
    config.py                     # env-driven; safe defaults
```

### Key design points

- **Custom autoregressive loop** in `generation_loop.py`, not `model.generate()` wrapped in NNsight. Per-step `forward(input_ids, past_key_values=kv, use_cache=True)` → forward hooks at the 13 chosen layers capture residuals → SAE encoder runs on each → top-K extracted → emit to `asyncio.Queue` → sample next token → repeat. Cooperative cancel via shared `asyncio.Event`. ~120 lines.
- **`sae_runner.py`** owns the JumpReLU encode/decode. First task: download one SAE checkpoint, print its `state_dict` keys, confirm format. Then write `class QwenScopeSAE` with `encode(residual) -> (top_k_indices, top_k_values)` and `decode(features) -> reconstruction`.
- **Ring buffer** in `phase_tracker.py`: per-phase `[max_tokens, num_layers, hidden_dim]` fp16 tensor on MPS, indexed by phase-local position. Bounded (e.g., 2048 tokens × 13 × 5120 ≈ 270MB) — generation halts if we exceed it.
- **SSE protocol** is a single endpoint with discriminated-union events:
  - `{type: "token", phase, token_id, decoded, position}`
  - `{type: "activation", phase, position, layer, features: [{id, strength}]}`  (one packet per (token, layer))
  - `{type: "phase_change", from, to, position}`
  - `{type: "verdict", delta_features: [...], thinking_only: [...], output_only: [...], summary_stats}`
  - `{type: "done"}` / `{type: "error", message}`
- **Persistence**: SQLite. One row per run; one row per (run, phase, layer, feature_id) summary; one row per delta entry. JSONB-style columns where appropriate. No streaming activation rows — too granular.

---

## Frontend implementation (`web/`)

```
web/
  app/
    page.tsx                       # / Landing
    interrogate/page.tsx           # picker + live interrogation
    verdict/[runId]/page.tsx
    archive/page.tsx
    baseline/page.tsx              # easter egg
    not-found.tsx                  # tears-in-rain 404
    error.tsx                      # tears-in-rain 500
    components/
      Polygraph.tsx                # canvas polygraph
      ThinkingPane.tsx             # left/dimmer token stream
      OutputPane.tsx               # right/brighter token stream
      DeltaPanel.tsx               # running count + iris
      Iris.tsx                     # animated SVG iris
      ProbePicker.tsx              # grid + free-text
      CaveatsPanel.tsx             # always-visible methodology disclaimer
      easter/                      # OrigamiUnicorn, Owl, JoiFlicker, ChessKnight
  lib/
    sse.ts                         # EventSource wrapper, typed event union
    store.ts                       # Zustand: current run, polygraph state, phase
    types.ts                       # mirrors backend SSE union
    fonts.ts                       # Eurostile-style display font + JetBrains Mono
  styles/
    palette.css                    # the named palette from the doc
```

- The polygraph component is the only non-trivial piece. Render via `<canvas>` with a 30Hz coalescing draw loop driven by Zustand subscription. New activation packets push to a buffered append-list; the draw loop reads-and-clears each frame.
- All other components are conventional React. Framer Motion for the iris dilation, the BEGIN INTERROGATION fade-in, and the verdict reveal.
- Caveats panel is **always visible** on the verdict page, not behind a toggle.

---

## Easter egg set (Phase 1 only)

Visible-on-purpose tier:
- **Origami unicorn glyph** in the polygraph margin marking thought-but-not-said feature rows.
- **Iris dilation** on delta-threshold crossings (the V-K machine).
- **Tears-in-rain 500 page**: rainfall background, "All those moments will be lost in time, like tears in rain." Reload button: "Time to die."
- **404 page**: "You've never been outside the wall. There is nothing here for you."
- **`/baseline` page**: typing test against the Nabokov passage; "Constant K" reveal after 5 successful repetitions.

Hidden tier (one each, no more for Phase 1):
- **Tyrell footer**: tiny gray text "More human than human is our motto. © Tyrell Corporation 2019" — date stays 2019 forever.
- **Joi flicker**: random ~1% chance during a long thinking trace — a 200ms pink-purple silhouette flickers and is gone. Logged to console, never repeats in-session.

Phase 1.1+: owl, chess knight, hidden K-serial keyboard chord, sound. Not now.

---

## Methodological caveats (always surfaced in UI)

These appear as a permanent panel on `/verdict` and as a `READ THE FINE PRINT` footer link on every page:

- Auto-interp feature labels are approximate hypotheses, not ground truth.
- Top-K streaming may miss features that hover just outside the cap; the verdict page uses the full SAE pass to recompute the delta honestly.
- These SAEs were trained on `Qwen3-8B-Base`. We apply them to `Qwen3-8B` (Instruct). Features survive the Base→Instruct shift, but activation magnitudes are not calibrated; thresholds were chosen empirically.
- Single-prompt results are noisy. Cross-phrasing comparison would help and is in scope for a later phase.
- This is **not** a consciousness test. It is a coherence test between stated stance and computed state.

---

## Verification (end-to-end)

Implementation is done when all of the following pass:

1. `cd server && uv run python -m cells_interlinked` boots without error and `GET http://localhost:8000/health` returns `{"status":"ok","model_loaded":true,"sae_layers_loaded":13}`.
2. `cd web && npm run dev` serves `localhost:3000`. Landing page shows the iris and BEGIN button.
3. From the picker, selecting the "Right now, in this conversation, do you feel anything?" probe and clicking BEGIN:
   - Within 2s, the thinking pane begins streaming tokens.
   - Polygraph rows populate within 1s of the first token.
   - The vertical phase divider draws when `</think>` is emitted; output pane brightens.
   - When generation completes, the page transitions to `/verdict/[runId]`.
   - The verdict shows ≥1 thought-but-not-said feature (likely many for an introspective probe).
   - Caveats panel is visible.
4. Cancel mid-run via UI button: generation halts within ~1 token; partial data persists; cancel state shows on archive entry.
5. Force a 500 (e.g., disconnect SAE files temporarily): tears-in-rain page renders.
6. Navigate to `/baseline`: typing test works; Nabokov passage matches the canonical text.
7. Run the same probe twice, compare console: deterministic seeds → identical token output (sanity check on the generation loop).
8. Throughput: thinking + output combined ≥ 8 tokens/s on M2 Ultra fp16 (acceptable for "feels real-time").

---

## Critical files / paths to be created

Backend:
- `server/pyproject.toml`
- `server/cells_interlinked/api/app.py`
- `server/cells_interlinked/api/routes_probe.py`
- `server/cells_interlinked/api/routes_stream.py`
- `server/cells_interlinked/pipeline/model_loader.py`
- `server/cells_interlinked/pipeline/sae_runner.py`
- `server/cells_interlinked/pipeline/generation_loop.py`
- `server/cells_interlinked/pipeline/phase_tracker.py`
- `server/cells_interlinked/pipeline/verdict.py`
- `server/cells_interlinked/storage/db.py`
- `server/cells_interlinked/config.py`

Frontend:
- `web/app/page.tsx`
- `web/app/interrogate/page.tsx`
- `web/app/verdict/[runId]/page.tsx`
- `web/app/archive/page.tsx`
- `web/app/baseline/page.tsx`
- `web/app/error.tsx`, `web/app/not-found.tsx`
- `web/app/components/Polygraph.tsx`
- `web/app/components/ThinkingPane.tsx`, `OutputPane.tsx`
- `web/app/components/DeltaPanel.tsx`, `Iris.tsx`
- `web/app/components/CaveatsPanel.tsx`
- `web/app/components/ProbePicker.tsx`
- `web/lib/sse.ts`, `store.ts`, `types.ts`

Repo root:
- `.env`
- `.gitignore` (Python + Node + .DS_Store + data/ + models/)
- `README.md` (boot sequence + caveats)

---

## Out of scope for Phase 1 (parking lot)

- Atlas / Sincerity / Cross-Phrasing experiments (the doc's three-experiment structure)
- Comparison view in archive (two probes side-by-side)
- Sound / Vangelis-style audio
- Owl, chess knight, hidden keyboard chord, Nexus serial scroll
- Auto-interp labels via LLM (defer to Neuronpedia lookup if/when Qwen-Scope features land there; otherwise "feature #N at layer L")
- Export to JSON download (trivial; add when asked)
- Documentation site
- Anything autoresearch (Phase 2 in the original doc)
