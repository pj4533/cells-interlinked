# Architecture — what got built

Companion doc to `cells-interlinked.md` (the pre-implementation handoff/concept) and
`phase-1-plan.md` (the Phase 1 plan that produced the code). This doc describes what
the code in this repo actually does, in the present tense.

---

## System diagram

```
┌──────────────────────────────────────────────────────────┐
│  Next.js 16 / React 19 / Tailwind v4   (port 3001)       │
│  ─ Landing, picker, interrogation, verdict, archive      │
│  ─ Polygraph (canvas), thinking + output token streams   │
│  ─ EventSource SSE consumer  (lib/sse.ts)                │
│  ─ Zustand store, Framer Motion                          │
└────────────────┬─────────────────────────────────────────┘
                 │  POST /probe   ─→ run_id
                 │  GET  /stream/{run_id}   (SSE)
                 │  POST /cancel/{run_id}
                 │  GET  /probes/recent | /probes/{run_id}
┌────────────────▼─────────────────────────────────────────┐
│  FastAPI / uvicorn               (port 8000)             │
│  ─ lifespan: load model + 13 SAEs once                   │
│  ─ RunRegistry: per-run asyncio.Queue + cancel.Event     │
│  ─ asyncio.Lock: one probe through the model at a time   │
│  ─ aiosqlite for persistence (server/data/probes.sqlite) │
└────────────────┬─────────────────────────────────────────┘
                 │  shared in-process queue
┌────────────────▼─────────────────────────────────────────┐
│  Generation pipeline (custom autoregressive)             │
│  ─ Qwen3-8B fp16 on MPS  (ModelBundle)                   │
│  ─ ResidualHooks on layers {2,6,10,14,16,18,20,22,24,    │
│       26,28,30,34} — capture last-position per step      │
│  ─ Per-token: sample → forward 1 token → emit token →   │
│       per-layer SAE encode_topk → emit activation       │
│  ─ PhaseTracker: token-ID-based <think>/</think> detect  │
│  ─ ResidualRing per phase (grows in 1024-token chunks)   │
│  ─ At end-of-run: compute_verdict() runs full SAE encode │
│       on each ring → mean/max/present-count → delta      │
└──────────────────────────────────────────────────────────┘
```

Both processes run locally. No network calls beyond the initial Hugging Face download.

---

## Request lifecycle

1. **User hits BEGIN.** Frontend POSTs `/probe` with prompt + optional sampling
   overrides. Backend assigns a 12-char `run_id`, inserts a row into SQLite (start
   time only), creates a `RunState` (queue + cancel event + task handle), and returns
   `{run_id}`.
2. **Frontend opens an EventSource on `/stream/{run_id}`.** The route drains the
   per-run queue and re-emits as named SSE events. Heartbeats (`ping`) every 1s during
   quiet periods to keep the connection alive.
3. **Backend `_execute_probe()` task runs in the background:**
   - Acquires `RunRegistry.lock` (one probe at a time through the model).
   - Calls `run_probe()` which executes the autoregressive loop.
   - On loop exit, calls `compute_verdict()` over the residual ring buffers.
   - Emits the `verdict` event, persists thinking/output text + verdict JSON to SQLite,
     emits `done`.
4. **Frontend Zustand store reduces each event** into the live UI state. When the run
   completes and a verdict is present, the page navigates to `/verdict/[runId]` after
   a 1.2s pause.
5. **Verdict page** GETs `/probes/{run_id}` to render the static record. The caveats
   panel is always visible.

---

## SSE event union (authoritative)

Backend emits these (`pipeline/generation_loop.py` + `api/routes_probe.py`); frontend
mirrors them in `web/lib/types.ts`.

| Event | Payload |
|---|---|
| `phase_change` | `{from: phase \| null, to: phase, position: int}` |
| `token` | `{phase, token_id, decoded, position}` |
| `activation` | `{phase, position, layer, features: [{id, strength}, ...]}` — one packet per (token, layer) |
| `stopped` | `{reason: "eos" \| "max" \| "cancelled" \| "ring_full" \| "error", total_tokens}` |
| `verdict` | `{thinking, output, deltas, thinking_only, output_only, summary_stats}` |
| `done` | `{}` |
| `error` | `{message}` |
| `ping` | `{}` (heartbeat; frontend ignores) |

Phase strings: `"prompt" | "thinking" | "output"`.

---

## Generation loop in detail (`pipeline/generation_loop.py`)

```
render prompt (chat template, enable_thinking=True)
  → if "<think>" appears in rendered text, initial phase = THINKING

initial forward(input_ids, use_cache=True)
  → discard prompt residuals (only generation residuals are streamed)
  → keep past_key_values, next_logits

for step in 0..safety_cap:
    if cancel_event.set: stop "cancelled"
    sample next token (temperature, top_p, seeded torch.Generator)
    phase_for_token = PhaseTracker.observe(token_id)
        # <think> → THINKING; </think> attributes-back to THINKING and switches to OUTPUT
    forward(tok, past_key_values=past_kv, use_cache=True)
        # ResidualHooks captured layer outputs at the last position
    layer_residuals = stack hooks → [num_layers, hidden_dim]
    rings[phase_for_token].append(layer_residuals)
    emit token event
    for layer in hook_layers:
        indices, values = sae.encode_topk(layer, residual, k=20)
        emit activation event
    if phase_after != phase_before: emit phase_change
    if token_id in eos_ids: stop "eos"

emit stopped event
return ProbeResult(rings, ...)
```

Hooks live for the duration of the run and are removed in `finally`.

---

## SAE runner (`pipeline/sae_runner.py`)

`QwenScopeSAE.__init__()` loads one layer's `.sae.pt` and runs `_infer_format()` on the
state_dict to figure out:
- encoder/decoder key names (`W_enc`/`encoder.weight`/`W_E`/...),
- whether each weight is stored as `[d_model, d_sae]` or `[d_sae, d_model]`,
- whether there's a pre-bias (`b_pre`/`b_dec`) applied before the encoder,
- whether there's a JumpReLU threshold (`threshold` / `log_threshold` / `jumprelu_threshold`).

The encoder weights load to MPS in fp16 immediately. The **decoder is loaded lazily**
on first `decode()` call — and right now nothing in the running pipeline calls
`decode()`, since the verdict pass uses `encode_full()` (dense feature vectors via the
encoder). The decoder code path is preserved for a future "what would the model have
said if we suppressed feature X" experiment.

`encode()` applies pre-bias subtraction, encoder matmul + bias, then either JumpReLU
gating (`where(z > threshold, z, 0)`) or plain ReLU. `encode_topk()` calls `encode()`
then `torch.topk(k)` along the feature dim.

Each layer's full state dict stays in CPU memory until `drop_full_state()` is called
explicitly (currently it isn't — total CPU footprint is ~1.7GB and we have headroom).

---

## Verdict pass (`pipeline/verdict.py`)

After generation halts:

1. For each phase ring (THINKING, OUTPUT) and each hooked layer, run `encode_full()` on
   the entire `[num_tokens, d_model]` slice.
2. From the dense `[num_tokens, d_sae]` features, compute per-feature `mean`, `max`,
   and `present_token_count` (count of tokens where activation > `min_strength=0.5`).
3. Pick top-N (=200) features by mean per layer, per phase. Build
   `{(layer, feature_id) → FeatureSummary}` dicts.
4. Take the union of (layer, feature_id) keys across both phases. For each, compute
   `delta = thinking_mean - output_mean` (zero-fill missing values).
5. Sort by delta descending, take top 60. A feature is "thinking-only" if the
   thinking mean > 0 and the output mean ≤ `output_floor=0.05`.

The Verdict object carries five lists (thinking top, output top, top deltas,
thinking_only, output_only) plus summary stats. The full thing is serialized to the
`verdict_json` column in SQLite.

---

## Persistence (`storage/db.py`)

Single table:

```sql
probes (
  run_id          TEXT PRIMARY KEY,
  prompt_text     TEXT NOT NULL,
  rendered_prompt TEXT NOT NULL,
  started_at      REAL NOT NULL,
  finished_at     REAL,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  stopped_reason  TEXT,
  thinking_text   TEXT,
  output_text     TEXT,
  verdict_json    TEXT,
  config_json     TEXT
)
```

Activations are **not** persisted — too granular. The full SAE pass is reproducible
from `rendered_prompt` + `config_json` if needed.

DB lives at `server/data/probes.sqlite` (path from `DB_PATH` env). The directory and
file are gitignored.

---

## Frontend rendering notes

- **Polygraph** (`web/app/components/Polygraph.tsx`) is canvas-rendered. Rows are
  pre-allocated; (layer, feature_id) pairs are assigned to the lowest free slot on
  first appearance and **never reordered** mid-run — visual stability matters more than
  perfect ranking. Final ranking by integrated activation happens on the verdict page.
- **API base URL** is derived in the browser from `window.location.hostname` + `:8000`
  (see `web/lib/sse.ts`). This means hitting the site from another machine on the LAN
  (e.g. `pjs-mac-studio.local:3001`) auto-points at the right backend. SSR/build path
  falls back to `localhost:8000`. Override via `NEXT_PUBLIC_API_BASE`.
- **Zustand store** (`web/lib/store.ts`) is a single `useRun` hook. The reducer in
  `apply()` is a switch on `evt.type` mirroring the backend union.
- **Framer Motion** is used sparingly: iris fade-in on landing, question echo entry on
  the interrogation screen, dilation pulses in the iris, the verdict reveal.

---

## Memory budget (measured / planned)

| Item | Approx |
|---|---|
| Qwen3-8B fp16 on MPS | ~16 GB |
| 13 SAE encoders fp16 (~700MB each) | ~9 GB |
| 13 SAE decoders (CPU, lazy; not yet GPU-resident) | ~9 GB CPU |
| Cached CPU state_dicts (until `drop_full_state()`) | ~1.7 GB |
| Residual ring buffer (per phase, grows in 1024-tok chunks) | ~270 MB / 2048 tok |
| Python + Next.js dev + OS | ~10 GB |
| **Total resident at idle, post-load** | ~35 GB |
| **Peak during full-encode verdict** | ~44 GB |

Comfortably within 64 GB on the M2 Ultra. Disk is the binding constraint, not RAM.

---

## Known gaps / parking lot

- **No auto-interp labels yet.** Verdict shows `feature #N at layer L`. When/if
  Neuronpedia covers Qwen-Scope features, hook in a lookup with caching.
- **No throughput measurement.** The plan target was ≥8 tok/s on M2 Ultra fp16;
  measure on first successful run.
- **End-to-end has not yet been booted** as of this commit. Implementation is complete;
  next step is `uv run python -m cells_interlinked` + `npm run dev` and walking through
  the first probe.
- **No tests yet.** The plan acknowledges this. The verification steps in
  `phase-1-plan.md` §"Verification" are the intended bar.
