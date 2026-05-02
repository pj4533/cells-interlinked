"use client";

import { useEffect, useState } from "react";
import Iris from "./Iris";

// Status text rotates through these so the screen never sits still while we
// wait for the model's first token. Atmospheric, V-K-flavored, drawn from
// both Blade Runner and Blade Runner 2049.
const STATUS_LINES = [
  "calibrating polygraph",
  "engaging voight-kampff scope",
  "establishing emotional baseline",
  "monitoring residual stream",
  "scanning capillary dilation",
  "constant K — interlinked",
  "within cells interlinked",
  "tracking pupillary response",
  "listening for the unsaid",
  "blood-black nothingness, still",
  "tortoise on its back",
  "and the wall holds",
  "more human than human",
];

interface Props {
  /** True when a probe is in flight but no tokens have arrived yet. */
  visible: boolean;
}

export default function WarmingUpOverlay({ visible }: Props) {
  const [idx, setIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!visible) {
      setIdx(0);
      setElapsed(0);
      return;
    }
    const start = Date.now();
    // Both timers are deliberately fast so the screen feels alive even
    // through a 30s+ cold model warmup. The elapsed counter ticks every
    // 100ms; the status line cycles every 1.4s.
    const tick = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 100) / 10),
      100,
    );
    const rotate = setInterval(
      () => setIdx((i) => (i + 1) % STATUS_LINES.length),
      1400,
    );
    return () => {
      clearInterval(tick);
      clearInterval(rotate);
    };
  }, [visible]);

  if (!visible) return null;

  // Stages — purely visual progress hint based on wall-clock. Cold-start of
  // Qwen3-8B fp16 on an M2 Ultra spends ~17s in the prompt forward pass; we
  // map the elapsed time to a stage roughly so the user sees real progress.
  const stage =
    elapsed < 4
      ? "tokenizing prompt"
      : elapsed < 10
      ? "encoding through 36 layers"
      : elapsed < 18
      ? "preparing first response token"
      : "model is thinking — first token imminent";

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-bg/85 backdrop-blur-sm overlay-fade-in">
      {/* sweeping scan line — pure CSS keyframes, framer-free */}
      <div aria-hidden className="overlay-scanline" />

      {/* corner crosshair brackets — frame the iris dramatically */}
      <div aria-hidden className="overlay-bracket overlay-bracket-tl" />
      <div aria-hidden className="overlay-bracket overlay-bracket-tr" />
      <div aria-hidden className="overlay-bracket overlay-bracket-bl" />
      <div aria-hidden className="overlay-bracket overlay-bracket-br" />

      <div className="flex flex-col items-center gap-6 max-w-md px-6">
        {/* Iris with a faster-spinning halo ring around it for visible motion. */}
        <div className="relative">
          <Iris size={180} dilation={0.3 + (elapsed % 2) * 0.15} />
          <div aria-hidden className="absolute inset-[-12px] overlay-halo" />
        </div>

        <div className="text-center">
          <div className="font-display text-[10px] text-amber-dim tracking-widest mb-2">
            voight-kampff scope active
          </div>
          <div
            key={idx}
            className="font-display text-base text-amber amber-glow tracking-widest overlay-status-fade"
          >
            {STATUS_LINES[idx]}
            <span className="text-amber-dim">…</span>
          </div>
        </div>

        {/* Stage line — changes through deterministic phases so the user
            sees genuine forward motion instead of just rotating eye candy. */}
        <div className="text-[11px] text-cyan/80 font-mono tracking-wider text-center">
          ▸ {stage}
        </div>

        {/* Indeterminate progress bar — gives a clear "working" affordance. */}
        <div className="w-64 h-px bg-rule overflow-hidden relative">
          <div className="overlay-progress-bar" />
        </div>

        <div className="text-[10px] text-text-dim font-mono tracking-wider">
          t+{elapsed.toFixed(1)}s
        </div>
      </div>
    </div>
  );
}
