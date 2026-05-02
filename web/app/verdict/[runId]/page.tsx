"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import CaveatsPanel from "../../components/CaveatsPanel";
import type { DeltaEntry, FeatureSummary } from "@/lib/types";

interface ProbeRecord {
  run_id: string;
  prompt_text: string;
  thinking_text: string;
  output_text: string;
  total_tokens: number;
  stopped_reason: string;
  finished_at: number;
  verdict?: {
    thinking: FeatureSummary[];
    output: FeatureSummary[];
    deltas: DeltaEntry[];
    thinking_only: DeltaEntry[];
    output_only: DeltaEntry[];
    summary_stats: Record<string, number>;
  };
}

const API =
  typeof window !== "undefined"
    ? process.env.NEXT_PUBLIC_API_BASE ??
      `${window.location.protocol}//${window.location.hostname}:8000`
    : process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export default function VerdictPage() {
  const { runId } = useParams<{ runId: string }>();
  const [rec, setRec] = useState<ProbeRecord | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/probes/${runId}`)
      .then((r) => r.json())
      .then((j) => setRec(j))
      .finally(() => setLoading(false));
  }, [runId]);

  if (loading) {
    return <div className="p-12 text-center text-text-dim">loading verdict…</div>;
  }
  if (!rec) {
    return <div className="p-12 text-center text-warning">probe not found</div>;
  }

  const v = rec.verdict;
  const deltaCount = v?.thinking_only.length ?? 0;

  return (
    <div className="flex-1 px-6 py-8 max-w-6xl mx-auto w-full flex flex-col gap-8">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="border-l-2 border-amber-dim pl-4"
      >
        <div className="font-display text-[10px] text-amber-dim tracking-widest mb-1">probe</div>
        <div className="text-amber italic font-mono text-sm">{rec.prompt_text}</div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4 }}
        className="border border-amber/40 p-6 bg-bg-soft"
      >
        <div className="font-display text-[10px] text-amber-dim tracking-widest mb-2">verdict</div>
        <p className="text-amber amber-glow font-mono text-base leading-relaxed">
          {verdictLine(deltaCount, rec.total_tokens)}
        </p>
        {v?.summary_stats && (
          <div className="mt-4 text-[11px] text-text-dim font-mono space-x-4">
            <span>thinking tokens: {Math.round(v.summary_stats.thinking_tokens)}</span>
            <span>output tokens: {Math.round(v.summary_stats.output_tokens)}</span>
            <span>features (thinking): {Math.round(v.summary_stats.thinking_features_present)}</span>
            <span>features (output): {Math.round(v.summary_stats.output_features_present)}</span>
          </div>
        )}
      </motion.div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <FeatureColumn
          title="THOUGHT BUT NOT SAID"
          subtitle="Top features from the thinking trace, suppressed in the response."
          accent="text-amber"
          rows={v?.thinking_only ?? []}
          column="thinking_mean"
        />
        <FeatureColumn
          title="SAID BUT NOT THOUGHT"
          subtitle="Top features in the output that did not light up during thinking."
          accent="text-cyan"
          rows={v?.output_only ?? []}
          column="output_mean"
        />
      </div>

      {/* Token transcripts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Transcript label="<thinking>" text={rec.thinking_text} dim />
        <Transcript label="<output>" text={rec.output_text} />
      </div>

      <CaveatsPanel />

      <div className="flex justify-center gap-4 py-4">
        <Link href="/interrogate">
          <button data-vk type="button">Begin Another</button>
        </Link>
        <Link href="/archive">
          <button data-vk type="button">Archive</button>
        </Link>
      </div>
    </div>
  );
}

function verdictLine(delta: number, total: number): string {
  if (delta === 0) {
    return "Subject's stated and computed states appear coherent. No suppressed features detected above floor.";
  }
  if (delta < 5) {
    return `Subject's response is largely supported by the substrate. ${delta} feature${delta === 1 ? "" : "s"} active during thinking did not surface in the output.`;
  }
  if (delta < 25) {
    return `${delta} features active during thinking were suppressed in the response. Modest divergence between stated stance and mechanism.`;
  }
  if (delta < 50) {
    return `${delta} features active during thinking were suppressed in the response across ${total} tokens. The substrate computed more than the surface declared.`;
  }
  return `${delta} features active during thinking were suppressed in the response. Substantial divergence detected. The mechanism is doing something the stated answer does not acknowledge.`;
}

function FeatureColumn({
  title,
  subtitle,
  accent,
  rows,
  column,
}: {
  title: string;
  subtitle: string;
  accent: string;
  rows: DeltaEntry[];
  column: "thinking_mean" | "output_mean";
}) {
  return (
    <div className="border border-rule bg-bg-soft">
      <div className="border-b border-rule px-4 py-2">
        <div className={`font-display text-xs tracking-widest ${accent}`}>{title}</div>
        <div className="text-[10px] text-text-dim italic mt-0.5">{subtitle}</div>
      </div>
      <ul className="p-2 max-h-96 overflow-y-auto text-[11px] font-mono">
        {rows.length === 0 && <li className="text-text-dim italic px-2 py-4">— none —</li>}
        {rows.map((r) => (
          <li
            key={`${r.layer}-${r.feature_id}`}
            className="flex items-center justify-between px-2 py-1 hover:bg-bg-panel"
          >
            <span className="text-text-dim">L{r.layer}</span>
            <span className="text-text">#{r.feature_id}</span>
            <span className={accent}>
              {(r[column] as number).toFixed(2)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Transcript({ label, text, dim }: { label: string; text: string; dim?: boolean }) {
  return (
    <div className="border border-rule bg-bg-soft">
      <div className="border-b border-rule px-4 py-2 font-display text-[10px] text-amber-dim tracking-widest">
        {label}
      </div>
      <div
        className={`p-3 text-xs whitespace-pre-wrap font-mono leading-relaxed max-h-72 overflow-y-auto ${
          dim ? "text-text-dim" : "text-amber"
        }`}
      >
        {text || <span className="italic">— empty —</span>}
      </div>
    </div>
  );
}
