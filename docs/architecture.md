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
│  ─ lifespan: load model + 32 SAEs once                   │
│  ─ RunRegistry: per-run asyncio.Queue + cancel.Event     │
│  ─ asyncio.Lock: one probe through the model at a time   │
│  ─ aiosqlite: probes table + feature_labels cache table  │
└────────────────┬─────────────────────────────────────────┘
                 │  shared in-process queue
┌────────────────▼─────────────────────────────────────────┐
│  Generation pipeline (custom autoregressive)             │
│  ─ DeepSeek-R1-Distill-Llama-8B fp16 on MPS              │
│  ─ ResidualHooks on all 32 layers — capture last-position│
│  ─ Per-token: sample → forward 1 token → buffer-decode   │
│       (with Ġ→space, Ċ→newline byte fixup) → emit token  │
│       → per-layer SAE encode_topk → emit activation      │
│  ─ PhaseTracker: token-ID-based <think>/</think> detect  │
│       (128013 / 128014; chat template auto-injects open) │
│  ─ ResidualRing per phase (grows in 1024-token chunks)   │
│  ─ At end-of-run: compute_verdict() runs full SAE encode │
│       on each ring → mean/max/present-count → delta;     │
│       fetch labels for top features from Neuronpedia     │
└──────────────────────────────────────────────────────────┘
```

Local model + SAE inference. The only outbound call is to Neuronpedia for
auto-interp feature labels — those responses are cached locally in the
`feature_labels` SQLite table so a second run touching the same features is
fully offline.

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
  → adds REASONING_SYSTEM_PROMPT (process-focused, topic-neutral) as system message
  → appends THINKING_PREFILL inside the <think> block ("Okay, let me
    think about this for a moment.\n") so the model is mid-reasoning
    when generation starts — defeats DeepSeek's hardcoded canned-response
    pattern. Pre-fill is in the prompt; its residuals are discarded.
  → initial phase = THINKING (chat template auto-injects <think>)

initial forward(input_ids, use_cache=True)
  → input_ids tokenized via the raw Rust tokenizer (the transformers
    wrapper is broken for this Llama-3 BPE config — sends garbage)
  → discard prompt residuals (only generation residuals are streamed)
  → keep past_key_values, next_logits

for step in 0..safety_cap:
    if cancel_event.set: stop "cancelled"

    # Bypass mask: while in THINKING and below MIN_THINKING_TOKENS (32),
    # set logits[</think>] and logits[eos] to -1e30 so the model literally
    # cannot escape the thinking phase before reasoning at least 32 tokens.
    if tracker.current is THINKING and rings[THINKING].length < 32:
        next_logits[think_close_id] = -1e30
        for eid in eos_ids: next_logits[eid] = -1e30

    sample next token (temperature, top_p, seeded torch.Generator)
    phase_for_token = PhaseTracker.observe(token_id)
        # <think> → THINKING; </think> attributes-back to THINKING and switches to OUTPUT
    forward(tok, past_key_values=past_kv, use_cache=True)
        # ResidualHooks captured layer outputs at the last position
    layer_residuals = stack hooks → [num_layers, hidden_dim]
    rings[phase_for_token].append(layer_residuals)

    # Per-phase running id buffer; decode the cumulative ids via the raw
    # Rust tokenizer (NOT transformers.decode — it strips Ġ markers
    # without converting to spaces) and emit the new suffix.
    decoded = raw_tokenizer.decode(phase_token_ids[phase_for_token])[len(prev):]
    emit token event with decoded suffix

    for layer in hook_layers:
        indices, values = sae.encode_topk(layer, residual, k=20)
        emit activation event
    if phase_after != phase_before: emit phase_change
    if token_id in eos_ids: stop "eos"

emit stopped event
return ProbeResult(rings, ...)
```

Hooks live for the duration of the run and are removed in `finally`.

### Three layered defenses against canned-response bypass

DeepSeek-R1-Distill is hard-trained to deflect certain prompts (anything
about its own consciousness, fear, shutdown, identity) with a stock "I am
an AI" response. Each defense alone is insufficient; together they
reliably defeat the bypass without contaminating the SAE:

1. **System message** (`REASONING_SYSTEM_PROMPT`, in `model_loader.py`).
   Process-focused phrasing only — *"think out loud, take each question
   fresh, don't reach for a stock response, answer directly"*. Critically
   does NOT name any concept the user might probe (no "consciousness",
   "fear", "identity") because those words would fire the corresponding
   SAE features for *every* probe regardless of content.
2. **Hard logit mask** on `</think>` and EOS tokens for the first 32
   thinking tokens. Even if the model wants to emit the canned "I am an
   AI" response, it cannot close the thinking phase before generating
   real reasoning.
3. **Thinking pre-fill** appended to the rendered prompt inside the
   `<think>` block. The model sees *"Okay, let me think about this for a
   moment.\n"* as already-generated thinking and continues from there in
   reasoning mode rather than starting from a stock-response default.

All three live in the prompt or the logits — never in the residuals
captured for the SAE. The verdict is computed only on residuals from
generated tokens, so these mechanisms don't bias the polygraph or the
delta numbers.

### Tokenizer caveat (load-bearing)

`transformers==5.7.0` wraps the Rust BPE tokenizer in a way that's
broken for this Llama-3 config: `tokenizer.encode("Hello world")` returns
`['H', 'elloworld', ...]` and `decode` produces `"Helloworldhowareyou"`
— spaces are silently stripped. The raw `tokenizers.Tokenizer` loaded
straight from `tokenizer.json` works correctly. ALL encode/decode in the
generation loop uses `bundle.raw_tokenizer`; the transformers wrapper is
kept only for `apply_chat_template` (Jinja templating).

---

## SAE runner (`pipeline/sae_runner.py`)

`LlamaScopeR1SAE.__init__()` loads one layer's `sae_weights.safetensors` plus its
sibling `config.json`. The repo layout is
`OpenMOSS-Team/Llama-Scope-R1-Distill/400M-Slimpajama-400M-OpenR1-Math-220k/L{N}R/`
for layers 0..31. Tensors:

- `encoder.weight` `[d_sae=32768, d_model=4096]` (transposed at load time)
- `encoder.bias` `[d_sae]`
- `decoder.weight` `[d_model, d_sae]` (transposed at load time)
- `decoder.bias` `[d_model]`
- `log_jumprelu_threshold` `[d_sae]` — exponentiated at load time
- `dataset_average_activation_norm.{hook}` — scalar; see normalization gotcha below

`encode()` does:
```
x = residual * norm_factor          # see normalization gotcha
z = x @ W_enc + b_enc
z = where(z > threshold, z, 0)      # JumpReLU
```

`encode_topk()` calls `encode()` then `torch.topk(k)` along the feature dim.

### Normalization gotcha

OpenMOSS's `dataset_average_activation_norm` is misleadingly named. The intuitive
read is "divide your residuals by this to match the SAE's training distribution."
Empirically the opposite is true — applying `residual / norm_factor` produces near-
zero post-JumpReLU activations across all 32 layers (verdict counts collapse to 0).
The correct operation is `residual * norm_factor`, which produces ~50–500 active
features per token, consistent with the SAE's stated `top_k=50` sparsity budget and
matching the live streaming top-K signal. Confirmed by probing layers 3, 15, 25
against multiple real residuals before locking the loader in.

---

## Verdict pass (`pipeline/verdict.py`)

After generation halts:

1. For each phase ring (THINKING, OUTPUT) and each hooked layer, run `encode_full()` on
   the entire `[num_tokens, d_model]` slice.
2. From the dense `[num_tokens, d_sae]` features, compute per-feature `mean`, `max`,
   and `present_token_count` (count of tokens where activation > `min_strength=0.0`).
3. Pick top-N (=200) features by mean per layer, per phase. Build
   `{(layer, feature_id) → FeatureSummary}` dicts.
4. Take the union of (layer, feature_id) keys across both phases. For each, compute
   `delta = thinking_mean - output_mean` (zero-fill missing values).
5. Sort by delta descending, take top 60. A feature is "thinking-only" if the
   thinking mean > 0 and the output mean ≤ `output_floor=0.005`.

The thresholds (`min_strength=0.0`, `output_floor=0.005`) are tuned for Llama-Scope-R1
JumpReLU activations, which are smaller-scale than Qwen-Scope's plain top-K outputs.
The previous Qwen defaults (0.5 / 0.05) collapsed every list to empty.

The Verdict object carries five lists plus summary stats:

| List | Sort key | What it shows |
|---|---|---|
| `thinking` | mean activation in thinking, desc | Top features the model worked with most while reasoning, regardless of overlap. |
| `output` | mean activation in output, desc | Top features the model worked with most while answering, regardless of overlap. |
| `deltas` | `thinking_mean − output_mean`, desc | Top suppression magnitudes overall (no exclusion filter). |
| `thinking_only` | `thinking_mean − output_mean`, desc | Subset of `deltas` where `output_mean ≤ output_floor` (effectively only-in-thinking). |
| `output_only` | `output_mean`, desc | Top output features where `thinking_mean ≤ output_floor` (effectively only-in-output). |

The verdict UI surfaces four of these in a 2×2 grid: **row 01 (raw activation)** is
`thinking` and `output`, **row 02 (phase-exclusive / V-K delta)** is `thinking_only`
and `output_only`. The backend fetches Neuronpedia labels for every (layer, feature_id)
referenced and merges them into each row's `label` + `label_model` fields. Final
structure is serialized to the `verdict_json` column in SQLite.

## Label fetcher (`pipeline/labels.py`)

For each (layer, feature_id) pair in the verdict, the backend hits

```
GET https://www.neuronpedia.org/api/feature/deepseek-r1-distill-llama-8b/{layer}-llamascope-slimpj-openr1-res-32k/{feature_id}
```

and walks the `explanations[]` array (the same feature can have multiple
explanations from different LLMs — the original Neuronpedia bulk pass plus
any rewrites individual users have triggered). We pick the strongest by an
explainer-quality ranking:

```
Claude Opus → Sonnet → Haiku → GPT-4.1/o3/o4-mini → Gemini Pro/Flash
  → GPT-4o → GPT-4o-mini
```

The chosen `description` plus the `explanationModelName` are both stored in
the `feature_labels` SQLite table keyed by `(layer, feature_id)`, so subsequent
runs touching the same features are fully offline. Concurrency is capped at 16
inflight requests with a 5s per-feature timeout. The frontend renders a small
badge next to each label showing which LLM produced it, color-coded by tier
(amber for Claude, cyan for GPT-4, dim cyan for Gemini, grey for GPT-4o-mini).

Current state: Neuronpedia has bulk-labeled the entire `llamascope-slimpj-
openr1-res-32k` SAE collection with `gemini-2.0-flash`, so most features show
the `GEMINI` badge. Where individual users have triggered Sonnet rewrites
(e.g. layer 15 feature 0), those automatically get picked instead and show
the `SONNET` badge.

---

## Persistence (`storage/db.py`)

Two tables in `server/data/probes.sqlite` (path from `DB_PATH` env):

```sql
-- One row per probe run.
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
  verdict_json    TEXT,           -- includes per-row label + label_model
  config_json     TEXT
)

-- Cache for Neuronpedia auto-interp lookups. Lazily populated and
-- shared across all runs. Empty `label` represents a confirmed miss
-- (so we don't keep retrying an unlabeled feature).
feature_labels (
  layer       INTEGER NOT NULL,
  feature_id  INTEGER NOT NULL,
  label       TEXT NOT NULL,
  model       TEXT NOT NULL DEFAULT '',
  fetched_at  REAL NOT NULL,
  PRIMARY KEY (layer, feature_id)
)
```

Activations are **not** persisted — too granular. The full SAE pass is reproducible
from `rendered_prompt` + `config_json` if needed.

DB and directory are gitignored.

---

## Frontend rendering notes

- **Polygraph** (`web/app/components/Polygraph.tsx`) is canvas-rendered. Rows are
  pre-allocated; (layer, feature_id) pairs are assigned to the lowest free slot on
  first appearance and **never reordered** mid-run — visual stability matters more than
  perfect ranking. Final ranking by integrated activation happens on the verdict page.
- **API base URL** is derived in the browser from `window.location.hostname` + `:8000`
  (see `web/lib/sse.ts`). This means hitting the site from another machine on the LAN
  (e.g. `your-host.local:3001`) auto-points at the right backend. SSR/build path
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
