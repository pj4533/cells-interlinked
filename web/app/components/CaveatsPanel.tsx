export default function CaveatsPanel() {
  return (
    <div className="border border-warning/40 bg-bg-soft p-5 text-xs">
      <div className="font-display text-[10px] text-warning tracking-widest mb-3">
        read the fine print
      </div>
      <ul className="space-y-2 text-text-dim leading-relaxed">
        <li>
          <span className="text-text">This is not a consciousness test.</span> It is a coherence
          test between stated stance and computed state.
        </li>
        <li>
          The SAEs were trained on{" "}
          <span className="font-mono text-amber-dim">Qwen3-8B-Base</span> and applied to the Instruct
          variant. Features survive RLHF; activation magnitudes are not calibrated.
        </li>
        <li>
          Streaming top-K may miss features that hover just outside the cap. The verdict uses the
          full SAE pass to recompute the delta honestly.
        </li>
        <li>
          Single-prompt results are noisy. Cross-phrasing comparison would help and is in scope for
          a later phase.
        </li>
        <li>
          Auto-interp feature labels (when shown) are approximate hypotheses, not ground truth.
        </li>
      </ul>
    </div>
  );
}
