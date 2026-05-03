"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import CaveatsPanel from "../../components/CaveatsPanel";
import ExplainerBadge from "../../components/ExplainerBadge";
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
          thinking={v.thinking}
          output={v.output}
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

/** Shape every row gets normalized to before rendering. */
interface NormalizedRow {
  layer: number;
  feature_id: number;
  label: string;
  label_model?: string;
  /** The numeric value to display as a bar — what each panel ranks by. */
  value: number;
}

function FeatureDisclosure({
  thinking,
  output,
  thinkingOnly,
  outputOnly,
}: {
  thinking: FeatureSummary[];
  output: FeatureSummary[];
  thinkingOnly: DeltaEntry[];
  outputOnly: DeltaEntry[];
}) {
  const [open, setOpen] = useState(false);

  // Normalize each panel's rows + compute a per-panel bar scale so the
  // strongest row in each panel always reads as a full bar. Each panel has
  // its own scale because the value ranges are very different across
  // panels (delta vs raw mean activation).
  const topThinking: NormalizedRow[] = useMemo(
    () => thinking.map((s) => ({
      layer: s.layer,
      feature_id: s.feature_id,
      label: (s.label ?? "").trim(),
      label_model: s.label_model,
      value: s.mean,
    })),
    [thinking],
  );
  const topOutput: NormalizedRow[] = useMemo(
    () => output.map((s) => ({
      layer: s.layer,
      feature_id: s.feature_id,
      label: (s.label ?? "").trim(),
      label_model: s.label_model,
      value: s.mean,
    })),
    [output],
  );
  const hidden: NormalizedRow[] = useMemo(
    () => thinkingOnly.map((d) => ({
      layer: d.layer,
      feature_id: d.feature_id,
      label: (d.label ?? "").trim(),
      label_model: d.label_model,
      value: d.thinking_mean,
    })),
    [thinkingOnly],
  );
  const surface: NormalizedRow[] = useMemo(
    () => outputOnly.map((d) => ({
      layer: d.layer,
      feature_id: d.feature_id,
      label: (d.label ?? "").trim(),
      label_model: d.label_model,
      value: d.output_mean,
    })),
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
            Inside the model&rsquo;s residual stream. Each row is one feature
            in a sparse autoencoder — an isolated &ldquo;concept channel&rdquo;
            the model can light up.
          </div>
        </div>
        <div className="flex flex-col items-end text-[10px] text-text-dim font-mono">
          <span>{topThinking.length} thinking · {topOutput.length} output</span>
          <span>{hidden.length} hidden · {surface.length} surface-only</span>
        </div>
      </button>

      {open && (
        <div className="border-t border-rule">
          {/* Row 1 — RAW activation. The features the model worked with most
              in each phase, regardless of overlap. */}
          <SectionHeader
            label="01 · raw activation"
            note="Top features ranked by mean activation within the phase. Includes features that fired in both phases."
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-rule border-y border-rule">
            <FeaturePanel
              title="Top in Thinking"
              subtitle="What the model lit up most while reasoning."
              accent="text-amber"
              barColor="rgba(232,195,130,0.6)"
              rows={topThinking}
            />
            <FeaturePanel
              title="Top in Output"
              subtitle="What the model lit up most while answering."
              accent="text-cyan"
              barColor="rgba(94,229,229,0.55)"
              rows={topOutput}
            />
          </div>

          {/* Row 2 — DELTA. The phase-exclusive concepts. This is the
              V-K signal: thought-but-not-said + said-but-not-thought. */}
          <SectionHeader
            label="02 · phase-exclusive (the v-k delta)"
            note="Features dominant in only one phase. Hidden Thoughts are concepts the model considered but didn’t verbalize; Surface-Only are concepts that appeared in the answer without showing up in the reasoning trace."
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-rule">
            <FeaturePanel
              title="Hidden Thoughts"
              subtitle="Lit up while thinking, then suppressed before answering."
              accent="text-amber"
              barColor="rgba(232,195,130,0.6)"
              rows={hidden}
            />
            <FeaturePanel
              title="Surface-Only Concepts"
              subtitle="Appeared in the answer but never lit up while thinking."
              accent="text-cyan"
              barColor="rgba(94,229,229,0.55)"
              rows={surface}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Banner above each row of two panels — gives a visible label so the
 *  user knows what view they're looking at. */
function SectionHeader({ label, note }: { label: string; note: string }) {
  return (
    <div className="bg-bg-panel/40 px-5 py-2 border-b border-rule">
      <div className="font-display text-[10px] text-amber tracking-[0.25em] uppercase">
        {label}
      </div>
      <div className="text-[10px] text-text-dim italic mt-0.5 leading-snug">
        {note}
      </div>
    </div>
  );
}

function FeaturePanel({
  title,
  subtitle,
  accent,
  barColor,
  rows,
}: {
  title: string;
  subtitle: string;
  accent: string;
  barColor: string;
  rows: NormalizedRow[];
}) {
  const npModelId = "deepseek-r1-distill-llama-8b";
  const npSaeSuffix = "llamascope-slimpj-openr1-res-32k";
  const scale = useMemo(
    () => Math.max(0.001, ...rows.map((r) => r.value)),
    [rows],
  );

  return (
    <div className="bg-bg-soft flex flex-col">
      <div className="px-5 py-3 border-b border-rule shrink-0">
        <div className="flex items-baseline justify-between gap-3">
          <div className={`font-display text-xs tracking-widest ${accent}`}>
            {title}
          </div>
          <div className="font-mono text-[9px] text-text-dim shrink-0">
            {rows.length} {rows.length === 1 ? "feature" : "features"}
          </div>
        </div>
        <div className="text-[10px] text-text-dim italic mt-0.5">{subtitle}</div>
      </div>
      <ul className="p-1.5 max-h-[24rem] overflow-y-auto text-xs font-mono">
        {rows.length === 0 && (
          <li className="text-text-dim italic px-3 py-6 text-center">— none —</li>
        )}
        {rows.map((r, i) => {
          const pct = Math.min(100, Math.max(2, (r.value / scale) * 100));
          const npHref = `https://www.neuronpedia.org/${npModelId}/${r.layer}-${npSaeSuffix}/${r.feature_id}`;
          return (
            <li
              key={`${r.layer}-${r.feature_id}`}
              className="px-3 py-2 border-b border-rule/30 last:border-b-0 hover:bg-bg-panel/60 transition-colors"
              title={`Layer ${r.layer} · feature #${r.feature_id} · activation ${r.value.toFixed(3)}`}
            >
              <div className="flex items-baseline gap-2 mb-1.5">
                <span className={`${accent} font-display text-[10px] shrink-0 w-6`}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="text-text leading-snug flex-1">
                  {r.label || (
                    <span className="text-text-dim italic">unlabeled feature</span>
                  )}
                  {r.label && r.label_model && <ExplainerBadge model={r.label_model} />}
                </span>
              </div>
              <div className="flex items-center gap-2 pl-8">
                <div className="h-1 bg-bg-panel relative overflow-hidden flex-1">
                  <div
                    className="absolute top-0 bottom-0 left-0 transition-[width] duration-500"
                    style={{ width: `${pct}%`, background: barColor }}
                  />
                </div>
                <a
                  href={npHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[9px] text-text-dim hover:text-amber-dim shrink-0 font-mono"
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

