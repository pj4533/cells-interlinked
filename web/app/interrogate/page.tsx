"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import ProbePicker from "../components/ProbePicker";
import TokenStream from "../components/TokenPanes";
import Polygraph from "../components/Polygraph";
import DeltaPanel from "../components/DeltaPanel";
import WarmingUpOverlay from "../components/WarmingUpOverlay";
import { startProbe, subscribe, cancelProbe } from "@/lib/sse";
import { useRun } from "@/lib/store";

export default function InterrogatePage() {
  const router = useRouter();
  const run = useRun();
  const [error, setError] = useState<string | null>(null);

  const handleBegin = async (text: string) => {
    try {
      setError(null);
      run.reset();
      const runId = await startProbe(text);
      run.start(runId, text);
      const unsub = subscribe(runId, {
        onEvent: (evt) => run.apply(evt),
        onError: () => setError("connection lost"),
      });
      // Stop subscription on navigation away (handled by useEffect cleanup elsewhere if needed).
      return () => unsub();
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    return () => run.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-navigate to verdict once the run is done and we have a verdict
  useEffect(() => {
    if (run.runId && !run.isRunning && run.verdict) {
      const id = run.runId;
      const t = setTimeout(() => router.push(`/verdict/${id}`), 1200);
      return () => clearTimeout(t);
    }
  }, [run.runId, run.isRunning, run.verdict, router]);

  // Compute the unicorn-feature set from the streaming top-K.
  const unicornFeatures = useMemo(() => {
    const thinking = new Set<string>();
    const output = new Set<string>();
    for (const c of run.cells) {
      const k = `${c.layer}:${c.featureId}`;
      if (c.phase === "thinking") thinking.add(k);
      else if (c.phase === "output") output.add(k);
    }
    const onlyThinking = new Set<string>();
    for (const k of thinking) if (!output.has(k)) onlyThinking.add(k);
    return onlyThinking;
  }, [run.cells]);

  if (!run.runId) {
    return <ProbePicker onBegin={handleBegin} disabled={run.isRunning} />;
  }

  const warmingUp = run.isRunning && run.totalTokens === 0;

  return (
    <div className="flex-1 flex flex-col gap-4 px-4 py-4 max-w-screen-2xl mx-auto w-full relative">
      {/* Question echo */}
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        className="border-l-2 border-amber-dim pl-4 py-1 flex items-center gap-3"
      >
        <div className="flex flex-col">
          <div className="font-display text-[10px] text-amber-dim tracking-widest mb-1">probe</div>
          <div className="text-amber italic font-mono text-sm">{run.prompt}</div>
        </div>
        {/* Live heartbeat — pulses whenever a run is active. */}
        {run.isRunning && (
          <motion.div
            className="ml-auto flex items-center gap-2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            <motion.div
              className="w-2 h-2 rounded-full bg-cyan"
              animate={{ opacity: [0.3, 1, 0.3], scale: [1, 1.4, 1] }}
              transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
              style={{ boxShadow: "0 0 8px rgba(94,229,229,0.6)" }}
            />
            <span className="font-display text-[10px] text-cyan-dim tracking-widest">
              live
            </span>
          </motion.div>
        )}
      </motion.div>

      {error && <div className="text-warning text-xs">⚠ {error}</div>}

      <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 14rem", flex: 1 }}>
        {/* Main column */}
        <div className="flex flex-col gap-4 min-h-0 relative">
          {/* Polygraph */}
          <div className="border border-rule h-72 bg-bg-soft relative overflow-hidden">
            <Polygraph
              cells={run.cells}
              phaseDividerPosition={run.phaseDividerPosition}
              unicornFeatures={unicornFeatures}
            />
            {/* Persistent sweep across the polygraph while a run is live. */}
            {run.isRunning && (
              <motion.div
                aria-hidden
                className="absolute top-0 bottom-0 w-px pointer-events-none"
                style={{
                  background: "rgba(94,229,229,0.25)",
                  boxShadow: "0 0 8px rgba(94,229,229,0.5)",
                }}
                initial={{ left: "32%" }}
                animate={{ left: ["32%", "100%", "32%"] }}
                transition={{ duration: 4.5, repeat: Infinity, ease: "linear" }}
              />
            )}
          </div>

          {/* Token streams side by side */}
          <div className="grid grid-cols-2 gap-4 flex-1 min-h-0">
            <TokenStream
              label="<thinking>"
              tokens={run.thinkingTokens}
              glow="dim"
              active={run.phase === "thinking" && run.isRunning}
            />
            <TokenStream
              label="<output>"
              tokens={run.outputTokens}
              glow="bright"
              active={run.phase === "output" && run.isRunning}
            />
          </div>
        </div>

        {/* Right rail */}
        <div className="flex flex-col gap-4">
          <DeltaPanel cells={run.cells} />
          <div className="flex flex-col gap-2 p-4 border border-rule bg-bg-soft">
            <div className="font-display text-[10px] text-amber-dim tracking-widest">status</div>
            <div className="text-xs">
              tokens: <span className="text-amber">{run.totalTokens}</span>
            </div>
            <div className="text-xs">
              phase: <span className="text-amber">{run.phase}</span>
            </div>
            <div className="text-xs">
              {run.isRunning ? (
                <span className="text-cyan animate-pulse">streaming…</span>
              ) : (
                <span className="text-text-dim">{run.stoppedReason ?? "idle"}</span>
              )}
            </div>
          </div>

          {run.isRunning && run.runId && (
            <button
              data-vk
              type="button"
              onClick={() => cancelProbe(run.runId!)}
            >
              Halt
            </button>
          )}
        </div>
      </div>

      <WarmingUpOverlay visible={warmingUp} />
    </div>
  );
}
