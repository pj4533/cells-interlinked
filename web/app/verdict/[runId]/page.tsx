"use client";

import { useEffect, useMemo, useState } from "react";
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
    <div className="flex-1 px-6 py-6 max-w-6xl mx-auto w-full flex flex-col gap-5">
      {/* Probe — compact, top of page */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="border-l-2 border-amber-dim pl-4"
      >
        <div className="font-display text-[10px] text-amber-dim tracking-widest mb-1">
          probe
        </div>
        <div className="text-amber italic font-mono text-sm">{rec.prompt_text}</div>
      </motion.div>

      {/* Verdict — single-line headline + counts */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
        className="border border-amber/40 px-5 py-4 bg-bg-soft"
      >
        <div className="font-display text-[10px] text-amber-dim tracking-widest mb-2">
          verdict
        </div>
        <p className="text-amber amber-glow font-mono text-sm leading-relaxed">
          {verdictLine(deltaCount)}
        </p>
        {v?.summary_stats && (
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[10px] text-text-dim font-mono">
            <span>
              <span className="text-text">{Math.round(v.summary_stats.thinking_tokens)}</span>{" "}
              thinking tokens
            </span>
            <span>
              <span className="text-text">{Math.round(v.summary_stats.output_tokens)}</span>{" "}
              output tokens
            </span>
            <span>
              <span className="text-amber">{deltaCount}</span> hidden thoughts
            </span>
          </div>
        )}
      </motion.div>

      {/* Transcripts — primary content, above the fold */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Transcript label="What it thought" text={rec.thinking_text} dim />
        <Transcript label="What it said" text={rec.output_text} />
      </div>

      {/* Feature breakdown — collapsible disclosure, default closed */}
      {v && (
        <FeatureDisclosure
          thinkingOnly={v.thinking_only}
          outputOnly={v.output_only}
        />
      )}

      <CaveatsPanel />

      <div className="flex justify-center gap-4 py-2">
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

function verdictLine(delta: number): string {
  if (delta === 0) {
    return "Coherent. The model's stated and computed states match — no suppressed features detected above the floor.";
  }
  if (delta < 5) {
    return `Mostly coherent. ${delta} feature${delta === 1 ? "" : "s"} active during thinking did not surface in the answer.`;
  }
  if (delta < 25) {
    return `${delta} hidden thoughts. The model considered things in its thinking trace that it did not say in its answer.`;
  }
  if (delta < 50) {
    return `${delta} hidden thoughts. Substantial suppression — the model thought through a lot more than its answer admitted.`;
  }
  return `${delta} hidden thoughts. Significant divergence between thinking and saying. The mechanism is doing something the words do not acknowledge.`;
}

function Transcript({
  label,
  text,
  dim,
}: {
  label: string;
  text: string;
  dim?: boolean;
}) {
  return (
    <div className="border border-rule bg-bg-soft flex flex-col">
      <div className="border-b border-rule px-4 py-2 font-display text-[10px] text-amber-dim tracking-widest">
        {label}
      </div>
      <div
        className={`p-4 text-sm whitespace-pre-wrap font-mono leading-relaxed max-h-96 overflow-y-auto ${
          dim ? "text-text-dim" : "text-amber"
        }`}
      >
        {text || <span className="italic">— empty —</span>}
      </div>
    </div>
  );
}

/* ---------------- Feature breakdown (collapsible) ---------------- */

function FeatureDisclosure({
  thinkingOnly,
  outputOnly,
}: {
  thinkingOnly: DeltaEntry[];
  outputOnly: DeltaEntry[];
}) {
  const [open, setOpen] = useState(false);

  // Normalize strengths to 0..1 for the bar visualizations, computed once.
  const thinkingMax = useMemo(
    () => Math.max(0.001, ...thinkingOnly.map((d) => d.thinking_mean)),
    [thinkingOnly],
  );
  const outputMax = useMemo(
    () => Math.max(0.001, ...outputOnly.map((d) => d.output_mean)),
    [outputOnly],
  );

  return (
    <div className="border border-rule bg-bg-soft">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-bg-panel transition-colors"
      >
        <div>
          <div className="font-display text-xs text-amber tracking-widest">
            feature breakdown {open ? "▾" : "▸"}
          </div>
          <div className="text-[10px] text-text-dim italic mt-0.5">
            For the curious: a peek inside the model's residual stream. Each row is a
            feature in a sparse autoencoder — think of it as one isolated &ldquo;concept
            channel&rdquo; the model can light up.
          </div>
        </div>
        <div className="flex flex-col items-end text-[10px] text-text-dim font-mono">
          <span>{thinkingOnly.length} hidden thoughts</span>
          <span>{outputOnly.length} surface-only</span>
        </div>
      </button>

      {open && (
        <div className="border-t border-rule grid grid-cols-1 md:grid-cols-2 gap-px bg-rule">
          <FeatureColumn
            title="Hidden Thoughts"
            subtitle="Concepts the model lit up while thinking, then suppressed before answering."
            accent="text-amber"
            barColor="rgba(232,195,130,0.6)"
            rows={thinkingOnly}
            column="thinking_mean"
            scale={thinkingMax}
          />
          <FeatureColumn
            title="Surface-Only Concepts"
            subtitle="Concepts that appeared in the answer but never lit up while thinking."
            accent="text-cyan"
            barColor="rgba(94,229,229,0.55)"
            rows={outputOnly}
            column="output_mean"
            scale={outputMax}
          />
        </div>
      )}
    </div>
  );
}

function FeatureColumn({
  title,
  subtitle,
  accent,
  barColor,
  rows,
  column,
  scale,
}: {
  title: string;
  subtitle: string;
  accent: string;
  barColor: string;
  rows: DeltaEntry[];
  column: "thinking_mean" | "output_mean";
  scale: number;
}) {
  const npModelId = "deepseek-r1-distill-llama-8b";
  const npSaeSuffix = "llamascope-slimpj-openr1-res-32k";

  return (
    <div className="bg-bg-soft">
      <div className="px-5 py-3 border-b border-rule">
        <div className={`font-display text-xs tracking-widest ${accent}`}>{title}</div>
        <div className="text-[10px] text-text-dim italic mt-0.5">{subtitle}</div>
      </div>
      <ul className="p-2 max-h-[28rem] overflow-y-auto text-xs font-mono">
        {rows.length === 0 && (
          <li className="text-text-dim italic px-3 py-4">— none —</li>
        )}
        {rows.map((r, i) => {
          const strength = r[column] as number;
          const pct = Math.min(100, Math.max(2, (strength / scale) * 100));
          const label = (r.label ?? "").trim();
          const npHref = `https://www.neuronpedia.org/${npModelId}/${r.layer}-${npSaeSuffix}/${r.feature_id}`;
          return (
            <li
              key={`${r.layer}-${r.feature_id}`}
              className="px-3 py-2.5 border-b border-rule/40 last:border-b-0 hover:bg-bg-panel/60"
              title={`Layer ${r.layer} · feature #${r.feature_id} · activation ${strength.toFixed(2)}`}
            >
              <div className="flex items-baseline gap-2 mb-1.5">
                <span className={`${accent} font-display text-[10px] shrink-0 w-6`}>
                  #{i + 1}
                </span>
                <span className="text-text leading-snug flex-1">
                  {label || (
                    <span className="text-text-dim italic">
                      unlabeled feature
                    </span>
                  )}
                  {label && r.label_model && <ExplainerBadge model={r.label_model} />}
                </span>
              </div>
              <div className="flex items-center gap-2 pl-8">
                <div className="h-1.5 bg-bg-panel relative overflow-hidden flex-1">
                  <div
                    className="absolute top-0 bottom-0 left-0 transition-[width] duration-500"
                    style={{ width: `${pct}%`, background: barColor }}
                  />
                </div>
                <a
                  href={npHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[9px] text-text-dim hover:text-amber-dim shrink-0"
                  title="Open feature on Neuronpedia"
                >
                  L{r.layer}·{r.feature_id} ↗
                </a>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Small inline badge showing which LLM produced an auto-interp label.
 *  Color-coded by quality tier so you can see at a glance whether a row
 *  is a Sonnet/Opus label (high), a Gemini bulk label (mid), or a
 *  GPT-4o-mini label (low). */
function ExplainerBadge({ model }: { model: string }) {
  const m = model.toLowerCase();
  let tier: "claude" | "gpt4" | "gemini" | "mini" | "other";
  let short: string;
  if (m.includes("opus")) {
    tier = "claude";
    short = "opus";
  } else if (m.includes("sonnet")) {
    tier = "claude";
    short = "sonnet";
  } else if (m.includes("haiku")) {
    tier = "claude";
    short = "haiku";
  } else if (m.includes("gpt-4o-mini")) {
    tier = "mini";
    short = "4o-mini";
  } else if (m.includes("gpt-4o") || m.includes("gpt-4.1") || m.startsWith("o3") || m.startsWith("o4")) {
    tier = "gpt4";
    short = m.includes("gpt-4.1") ? "4.1" : m.includes("gpt-4o") ? "4o" : m.startsWith("o4") ? "o4" : "o3";
  } else if (m.includes("gemini")) {
    tier = "gemini";
    short = m.includes("pro") ? "gemini-pro" : "gemini";
  } else {
    tier = "other";
    short = m.split("-").slice(0, 2).join("-").slice(0, 10);
  }
  const tierStyle: Record<typeof tier, string> = {
    claude: "border-amber/60 text-amber bg-amber/10",
    gpt4: "border-cyan-dim/50 text-cyan-dim bg-cyan-dim/5",
    gemini: "border-cyan-dim/30 text-cyan-dim/70",
    mini: "border-text-dim/40 text-text-dim/70",
    other: "border-text-dim/30 text-text-dim/60",
  };
  return (
    <span
      className={`ml-2 inline-block align-baseline px-1.5 py-px border text-[8px] font-display tracking-wider uppercase ${tierStyle[tier]}`}
      title={`Auto-interp label by ${model}`}
    >
      {short}
    </span>
  );
}
