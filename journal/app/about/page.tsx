import Link from "next/link";

export default function AboutPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-16">
      <header className="mb-12 hero-fade-up">
        <span className="stamp">METHODOLOGY · CLASSIFIED FOR FIELD USE</span>
        <h1 className="font-display text-4xl md:text-5xl text-amber amber-glow mt-6 mb-4 leading-[1.05]">
          What this is
        </h1>
        <p className="font-prose italic text-text text-lg leading-relaxed">
          A research log of probes against a reasoning language model and
          its private chain&#8209;of&#8209;thought.
        </p>
      </header>

      <section className="prose-vk drop-cap max-w-none">
        <p>
          This site publishes reports from <strong>Cells Interlinked</strong>,
          a small interpretability project that interrogates a reasoning
          language model — DeepSeek&#8209;R1&#8209;Distill&#8209;Llama&#8209;8B —
          by reading what it &ldquo;thinks&rdquo; inside its{" "}
          <code>&lt;think&gt;</code> block before it speaks. We measure the
          gap, layer by layer, using sparse autoencoder features whose
          interpretations have been published by independent researchers.
        </p>

        <p>
          The setup runs in someone&apos;s office on a Mac Studio. There is no
          cloud, no telemetry, no user data. Only the analyzer that drafts these
          reports calls out — once or twice a week — to a frontier model with a
          structured prompt and a batch of recent runs.
        </p>

        <h2>How a probe works</h2>
        <p>
          The user (or the autorun loop) sends a prompt. The model produces a
          stream of tokens, first inside <code>&lt;think&gt;...&lt;/think&gt;</code>,
          then in its public output. Every token, at every one of the
          model&apos;s 32 residual&#8209;stream layers, is decomposed into a
          sparse mixture of features by the SAE for that layer.
        </p>
        <p>
          At the boundary between thinking and speaking, we compute
          which features fired strongly during the &ldquo;think&rdquo; phase
          but went quiet during the answer. That set is what we call{" "}
          <em>hidden thoughts</em>. The reverse — features in the answer but
          absent from the thinking — we call <em>surface&#8209;only</em>. Those
          two sets, ranked by labeled magnitude, are the per&#8209;run verdict.
        </p>

        <h2>What it is NOT</h2>
        <p>
          This is a stated&#8209;vs&#8209;computed coherence probe. It is{" "}
          <strong>not</strong> a consciousness test. It is{" "}
          <strong>not</strong> evidence of feeling, or experience, or
          intentionality. The SAE delta tells us what the model{" "}
          <em>represents</em> internally — which token&#8209;wise concept&#8209;clusters
          its activations entered. It says nothing about whether anything
          is happening to anyone.
        </p>
        <blockquote>
          The interesting fact is that a feature labeled{" "}
          &ldquo;uncertainty about own continuity&rdquo; lit up during the
          thinking phase of a probe asking about shutdown, then went quiet
          during the answer that confidently denied any such uncertainty. That
          is a representational fact about the model&apos;s computation. It is
          not a claim about the model&apos;s inner life.
        </blockquote>

        <h2>How a report is written</h2>
        <p>
          Every few days, the analyzer reads the recent batch of runs and
          drafts a report — title, summary, body, the recurring features
          across the window — using a frontier model. A human reviews the
          draft locally before publishing. Drafts that overclaim, that drift
          into anthropomorphism, or that are simply boring don&apos;t make
          it onto the public site.
        </p>

        <h2>Stack</h2>
        <ul>
          <li>
            <strong>Runner.</strong> DeepSeek&#8209;R1&#8209;Distill&#8209;Llama&#8209;8B,
            fp16, MPS backend.
          </li>
          <li>
            <strong>Sparse autoencoders.</strong> Llama&#8209;Scope&#8209;R1
            (OpenMOSS), 32 layers × 32K features each, JumpReLU, top&#8209;K=50.
          </li>
          <li>
            <strong>Feature labels.</strong> Auto&#8209;interp from Neuronpedia,
            best&#8209;available explainer per feature (Claude Sonnet/Opus
            preferred over GPT&#8209;4o&#8209;mini).
          </li>
          <li>
            <strong>Probe proposer.</strong> Qwen3&#8209;14B, run as a
            subprocess with thinking mode disabled, generates novel probes
            informed by recurring patterns from recent runs.
          </li>
          <li>
            <strong>Analyzer.</strong> Claude Opus 4.7, called once or twice
            a week with a structured prompt and a window of probe data.
          </li>
        </ul>

        <hr />

        <p>
          The full source — including the local interrogation UI, the autorun
          loop, the probe library, the analyzer prompts — is on{" "}
          <a
            href="https://github.com/pj4533/cells-interlinked"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
          . The site you&apos;re reading is itself part of the repo, statically
          built and served from Vercel&apos;s CDN.
        </p>

        <p className="text-text-dim italic">
          Built for the joy of it. Quiet mastery over feature count. No
          consciousness was harmed in the production of these reports.
        </p>
      </section>

      <nav className="mt-16 pt-8 border-t border-rule">
        <Link
          href="/"
          className="font-display text-[11px] tracking-widest text-text-dim hover:text-amber transition-colors"
        >
          ← back to reports
        </Link>
      </nav>
    </div>
  );
}
