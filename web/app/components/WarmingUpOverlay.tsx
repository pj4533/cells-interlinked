"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
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
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 100) / 10), 100);
    const rotate = setInterval(
      () => setIdx((i) => (i + 1) % STATUS_LINES.length),
      1800,
    );
    return () => {
      clearInterval(tick);
      clearInterval(rotate);
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.6 }}
      className="absolute inset-0 z-30 flex items-center justify-center bg-bg/90 backdrop-blur-sm"
    >
      {/* sweeping scan line across the overlay */}
      <motion.div
        aria-hidden
        className="absolute left-0 right-0 h-[2px] pointer-events-none"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(232,195,130,0.6), transparent)",
          boxShadow: "0 0 12px rgba(232,195,130,0.5)",
        }}
        initial={{ top: "0%" }}
        animate={{ top: ["0%", "100%", "0%"] }}
        transition={{ duration: 3.2, repeat: Infinity, ease: "linear" }}
      />

      <div className="flex flex-col items-center gap-6">
        <Iris size={180} dilation={0.3 + (elapsed % 2) * 0.15} />

        <div className="text-center">
          <div className="font-display text-[10px] text-amber-dim tracking-widest mb-1">
            warming up
          </div>
          <motion.div
            key={idx}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="font-display text-sm text-amber amber-glow tracking-widest"
          >
            {STATUS_LINES[idx]}
            <span className="animate-pulse text-amber-dim">…</span>
          </motion.div>
        </div>

        <div className="flex items-center gap-3">
          {/* tick marks */}
          {Array.from({ length: 5 }).map((_, i) => (
            <motion.div
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-amber-dim"
              animate={{ opacity: [0.2, 1, 0.2] }}
              transition={{
                duration: 1.4,
                repeat: Infinity,
                delay: i * 0.18,
                ease: "easeInOut",
              }}
            />
          ))}
        </div>

        <div className="text-[10px] text-text-dim font-mono tracking-wider">
          t+{elapsed.toFixed(1)}s
        </div>
      </div>
    </motion.div>
  );
}
