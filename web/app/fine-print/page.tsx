import CaveatsPanel from "../components/CaveatsPanel";

export default function FinePrint() {
  return (
    <div className="flex-1 px-6 py-8 max-w-3xl mx-auto w-full flex flex-col gap-6">
      <h1 className="font-display text-2xl text-amber amber-glow">The Fine Print</h1>
      <p className="text-text-dim text-sm italic leading-relaxed">
        This site is an interpretability toy. It looks at sparse-autoencoder features that fire
        inside a small open-source language model — Qwen3-8B — while the model thinks aloud and
        while it answers. It compares the two. The comparison is suggestive, not conclusive.
      </p>
      <CaveatsPanel />
      <div className="text-text-dim text-[11px] leading-relaxed mt-4">
        <p>
          The Voight-Kampff machine in <em>Blade Runner</em> works because pupil dilation is harder
          to fake than a verbal response. The analogue here is that internal feature activations
          during the thinking phase are{" "}
          <em>somewhat</em> harder to RLHF-shape than the final answer. Recent work on reasoning
          models — Goodfire&apos;s SAE study of DeepSeek-R1, the &ldquo;Why Models Know But
          Don&apos;t Say&rdquo; paper, Anthropic&apos;s introspection-adapter line — has surfaced
          measurable divergence between thinking-trace features and final-answer features. This
          site visualizes the same shape on a smaller, locally-runnable model.
        </p>
      </div>
    </div>
  );
}
