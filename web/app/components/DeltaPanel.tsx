"use client";

import { useMemo } from "react";
import type { ActivationCell } from "@/lib/store";
import Iris from "./Iris";

interface DeltaPanelProps {
  cells: ActivationCell[];
}

/** Counts the rolling estimate of features that fired in thinking but not in output.
 *  This is a streaming approximation; the verdict page uses the real full SAE pass.
 *
 *  Approach: accumulate per-feature total strength across each phase, then keep only
 *  the top-N strongest features in thinking (mirrors what the verdict's full SAE pass
 *  does at the end). A "hidden thought" = top-N thinking feature whose summed
 *  output-phase strength is at most a small fraction of its thinking strength. */
const TOP_N = 200;
const SUPPRESSION_RATIO = 0.1;

export default function DeltaPanel({ cells }: DeltaPanelProps) {
  const { count, totalThinking, totalOutput } = useMemo(() => {
    const thinkingScore = new Map<string, number>();
    const outputScore = new Map<string, number>();
    for (const c of cells) {
      const k = `${c.layer}:${c.featureId}`;
      if (c.phase === "thinking") {
        thinkingScore.set(k, (thinkingScore.get(k) ?? 0) + c.strength);
      } else if (c.phase === "output") {
        outputScore.set(k, (outputScore.get(k) ?? 0) + c.strength);
      }
    }
    const topThinking = [...thinkingScore.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N);
    let hidden = 0;
    for (const [k, s] of topThinking) {
      const out = outputScore.get(k) ?? 0;
      if (out <= s * SUPPRESSION_RATIO) hidden++;
    }
    return {
      count: hidden,
      totalThinking: topThinking.length,
      totalOutput: outputScore.size,
    };
  }, [cells]);

  // Iris dilation thresholds: 5, 25, 50
  const dilation = count >= 50 ? 1.0 : count >= 25 ? 0.6 : count >= 5 ? 0.3 : 0;
  const alarmed = count >= 50;

  return (
    <div className="flex flex-col gap-4 p-4 border border-rule bg-bg-soft">
      <div className="flex items-center justify-center">
        <Iris size={140} dilation={dilation} alarmed={alarmed} />
      </div>
      <div className="text-center">
        <div className="font-display text-[10px] text-amber-dim tracking-widest">live delta</div>
        <div className="font-display text-3xl text-amber amber-glow mt-1">{count}</div>
        <div className="text-[10px] text-text-dim italic mt-1">
          thought but not said
          <span className="block text-[9px] text-text-dim/70">(streaming estimate — verdict will refine)</span>
        </div>
      </div>
      <div className="flex justify-around text-[10px] text-text-dim border-t border-rule pt-3">
        <div className="text-center">
          <div className="text-text">{totalThinking}</div>
          <div>thinking</div>
        </div>
        <div className="text-center">
          <div className="text-text">{totalOutput}</div>
          <div>output</div>
        </div>
      </div>
    </div>
  );
}
