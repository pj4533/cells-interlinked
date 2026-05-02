"use client";

import { useMemo } from "react";
import type { ActivationCell } from "@/lib/store";
import Iris from "./Iris";

interface DeltaPanelProps {
  cells: ActivationCell[];
}

/** Counts the rolling estimate of features that fired in thinking but not in output.
 *  This is a streaming approximation; the verdict page uses the real full SAE pass. */
export default function DeltaPanel({ cells }: DeltaPanelProps) {
  const { count, totalThinking, totalOutput } = useMemo(() => {
    const thinking = new Set<string>();
    const output = new Set<string>();
    for (const c of cells) {
      const k = `${c.layer}:${c.featureId}`;
      if (c.phase === "thinking") thinking.add(k);
      else if (c.phase === "output") output.add(k);
    }
    let onlyThinking = 0;
    for (const k of thinking) if (!output.has(k)) onlyThinking++;
    return { count: onlyThinking, totalThinking: thinking.size, totalOutput: output.size };
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
        <div className="font-display text-[10px] text-amber-dim tracking-widest">delta</div>
        <div className="font-display text-3xl text-amber amber-glow mt-1">{count}</div>
        <div className="text-[10px] text-text-dim italic mt-1">thought but not said</div>
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
