# Next steps — paid experiments worth considering

Captured from a research session on 2026-05-03. None of this is committed
work; it's a menu of possible upgrades the project could take if/when
willing to spend cloud compute and API credits. Everything here keeps the
core constraint intact: **runs locally on the M2 Ultra after the one-time
cloud spend**. No always-on cloud costs.

## What's *not* worth the spend

These came up in research and got ruled out. Documenting so we don't
re-explore them later.

- **Switch to DeepSeek V4** (the April 2026 frontier model). V4-Pro is 1.6T
  params (~3.2 TB fp16); V4-Flash is 284B (~568 GB). Neither runs on M2
  Ultra at any quantization. More importantly, no SAEs exist for V4 from
  anyone — Goodfire's last published SAE was August 2025 (Llama 3.3 70B
  hackathon) and their Ember API was deprecated Feb 2026. Earliest
  realistic V4 SAE availability: Q3-Q4 2026.
- **Always-on cloud hosting for public access.** ~$1,100-2,000/month at
  realistic provider rates. Doesn't scale economically and we don't want a
  public surface anyway.
- **Wider 128K-feature SAEs on the same R1-Distill-Llama-8B** model. Real
  improvement (4× dictionary, cleaner labels) but only an *incremental*
  upgrade — labels become noticeably sharper but still polysemantic,
  because going truly monosemantic needs ~1M features per layer (Anthropic-
  scale work). Skipped because the cost-to-wow ratio isn't great relative
  to the options below.
- **Goodfire DeepSeek-R1 SAEs** (the only published reasoning-model SAEs
  trained at frontier scale). Trained on the full 671B R1 — model itself
  doesn't run anywhere realistic. SAE weights are public but useless without
  inference on the matching model.

## What's worth the spend (ordered by effort)

All four options below produce **a model + multi-layer labeled SAE
combination that doesn't currently exist in the public ecosystem**. Each
gives us novel data nobody else has — that's the real "wow" angle, not just
"the same thing slightly better."

After the spend, everything runs on the M2 Ultra forever. The cloud is
purely for the one-time training + labeling pass.

### Option 1 — Qwen3.5-9B (cheapest, validates the pipeline)

- **Total one-time cost: ~$100-200**
- **What's new:** Qwen-Scope already published 64K-wide SAEs for Qwen3.5-9B,
  but ships *zero* labels. We just need to label them.
- **Why it matters:** validates we can run the full label-only pipeline on
  a new model. Lowest risk; if it goes well, scale to bigger spend.
- **Constraints:** model fits comfortably on M2 Ultra (~18 GB fp16). Native
  `<think>` mode. The 64K-wide SAEs would push memory tight when added to
  the model + Python + Next.js — may need to load decoder weights lazily
  (we already do this).
- **What you'd see:** the verdict page, but on Qwen3 instead of R1-Distill,
  with cleaner labels we generated and own. Different reasoning style;
  different hidden-thought patterns surface.

### Option 2 — Qwen3-14B from-scratch SAEs (recommended bigger bet)

- **Total one-time cost: ~$350-600** (training: $250-400 in H100/H200 time;
  labeling: $100-200 in Sonnet/Haiku API)
- **What's new:** no SAEs exist for Qwen3-14B yet from anyone. We'd train
  the first ones, label them with our own pipeline, drop into the existing
  app architecture.
- **Why it matters:** Qwen3-14B has the cleanest thinking-mode toggle of
  any open model (`/think` and `/no_think` slash commands), genuinely
  better reasoning quality than 8B-class models, and is unexplored from an
  interpretability angle. The verdict page would show the only multi-layer
  labeled SAE in existence for Qwen3-14B. Publishable / shareable territory.
- **Constraints:** Qwen3-14B fp16 ~28 GB. With 32 layers × 32K SAE encoders
  (~17 GB), total ~45 GB resident — fits in 64 GB unified with overhead
  headroom for Python + Next.js. Tight but workable.
- **What you'd see:** noticeably smarter reasoning traces in the thinking
  pane, more nuanced introspection in the output, and (because we control
  labeling quality) much cleaner concept names than what Gemini's bulk pass
  generates today.

### Option 3 — DeepSeek-R1-Distill-Qwen-14B (cross-architecture comparison)

- **Total one-time cost: ~$350-600** (same shape as Option 2)
- **What's new:** same R1 reasoning distillation we already understand, but
  applied to the Qwen2.5 base architecture instead of Llama 3.1.
- **Why it matters:** lets us A/B compare the *same probe* against
  R1-Distill-Llama-8B (current) and R1-Distill-Qwen-14B (new). Real
  interpretability research question: "does R1-distillation create the same
  hidden thoughts regardless of base model?" If the recurring features
  cluster differently, that's a finding. If they cluster the same, that's
  also a finding — about what R1's training imprints universally.
- **Constraints:** ~28 GB fp16, fits like Qwen3-14B does.
- **What you'd see:** verdict + archive pages showing R1-Distill-Qwen-14B
  hidden thoughts, directly comparable to existing R1-Distill-Llama-8B
  archive. The aggregate "patterns across runs" view becomes a much more
  meaningful tool because it's now comparing *two* model variants.

### Option 4 — Mistral 14B Reasoning (highest novelty)

- **Total one-time cost: ~$350-600**
- **What's new:** Mistral 3 family just dropped (early 2026); Apache 2.0
  license, native reasoning mode. Virtually no interpretability work has
  been done on it yet.
- **Why it matters:** highest novelty score of any option. Whatever we find
  is genuinely first-time-seen.
- **Constraints:** same memory profile as Option 2/3.
- **Risks:** less community work to build on. SAE training might need more
  iteration to converge cleanly. Higher chance the first attempt produces
  a mediocre dictionary and needs a re-run.

## Recommended sequencing if spending in stages

Don't commit to all of this upfront. The natural order:

1. **Phase A: Qwen3.5-9B label-only** ($100-200, ~1 weekend of work)
   - Proves the pipeline supports a new model + new SAE collection
   - Proves we can run label generation cost-effectively
   - Result: working verdict page on Qwen3.5-9B with our-own labels
   - If this fails or feels disappointing, stop. Total burn: ~$200.

2. **Phase B: Qwen3-14B from-scratch SAEs** ($350-600, ~1-2 weeks of work
   spread over a month)
   - The bigger model upgrade with novel SAEs we trained
   - Builds on the labeling pipeline from Phase A
   - Result: the only multi-layer labeled SAE in existence for Qwen3-14B,
     running at home on the M2 Ultra
   - If this feels like a real wow, you have something publishable.

3. **Phase C (optional): R1-Distill-Qwen-14B for comparison** ($350-600)
   - Adds the cross-architecture A/B angle
   - Most valuable if Phase B produced interesting recurring patterns and
     you want to test whether they're R1-specific or base-model-specific

Cumulative cost across all three phases: **~$1000-1500** — spread over
months, with each phase producing a working result before the next
commitment.

## Cost components, broken down

For each from-scratch SAE training option:

**Training (per model)**
- 32 layers × 32K width JumpReLU SAEs
- Reference: OpenMOSS Llama-Scope paper trained 256 SAEs in ~3 weeks on
  H100s ≈ ~6 GPU-hours per SAE
- Our 32 × ~6 hrs = **~150-250 GPU-hours**
- At RunPod H100 ($1.49/hr): **$225-375**
- At H200 ($2.50/hr, faster, fits wider widths if we wanted): **$375-625**
- Plus activation collection (~10 GPU-hours, negligible): +$15-25

**Labeling (per model)**
- Top ~5K features per layer × 32 layers = ~150K features worth labeling
- Sonnet 4.6 ($3 input / $15 output per MTok): ~$0.01/feature → $1500 (overkill)
- Haiku 4.5 ($1 input / $5 output per MTok): ~$0.003/feature → $450
- **Smart hybrid**: Haiku for bulk, Sonnet for top-N features that actually
  surface in verdicts. Realistic spend: **$100-200**

**One-time persistent storage** (during a training run only)
- ~100 GB persistent volume on RunPod / Lambda: ~$5-10/month
- Only billed during the active training/labeling phase; can be deleted after

## The "personal on-demand" cloud workflow

When/if we do any of this:

- **RunPod** with a 100 GB persistent volume + custom Docker template
  pre-built with `uv`, our repo, and HF cache populated
- Click "Deploy", pod boots in ~30 seconds (volume mount, no re-download)
- SSH or browser terminal; run training script; SSH-tunnel ports back to
  laptop if you want the web UI live
- Done? Click "Stop". Volume persists for next session (~$5-10/mo idle);
  GPU billing stops immediately.
- Alternatives ranked: **Lambda Cloud** (slightly nicer UX, $2.99/hr H100,
  persistent storage included), **Vast.ai** (cheapest at ~$1.00/hr H100
  spot, more rough edges), **Modal** (good if you prefer everything as
  Python code rather than SSH).

## What this would look like in the existing app

For all four options the UI doesn't change. Same probe picker, same
warming-up overlay, same polygraph, same verdict 2×2 grid, same archive
aggregate. Three config changes:

- `MODEL_NAME` in `.env`
- `SAE_REPO` in `.env` pointing at our published HF repo with the new SAEs
- `NEURONPEDIA_MODEL_ID` / `NEURONPEDIA_SAE_SUFFIX` updated, OR we replace
  the label fetcher with a local lookup if we host labels locally instead
  of pushing to Neuronpedia

The code that's model-agnostic stays unchanged: generation loop, phase
tracker, residual ring buffer, verdict computation, polygraph rendering,
archive aggregation. That's intentional from the original architecture and
pays off here — the project supports model swaps cleanly.

## Watch-and-wait items (no spend, but worth checking quarterly)

- **OpenMOSS** (Hugging Face: `OpenMOSS-Team`) — they ship new SAE collections
  every few months. If they publish for Qwen3-14B or any V4-distill, our
  Phase B becomes free.
- **Goodfire** (Hugging Face: `Goodfire`) — they may ship V4 SAEs eventually
  even though Ember API is deprecated.
- **Neuronpedia** (`neuronpedia.org`) — they periodically re-bulk-label
  existing SAEs with newer/better explainers. Our existing R1-Distill-Llama-8B
  labels could get a free upgrade if they re-run with Sonnet 4.6 or
  Claude Opus 4.x.
- **DeepSeek V4 distills** — when DeepSeek (or community) releases
  `DeepSeek-V4-Distill-Llama-8B` or similar, the V4 reasoning quality
  becomes accessible on M2 Ultra hardware. SAE situation still unclear at
  that point but the model side becomes free.
