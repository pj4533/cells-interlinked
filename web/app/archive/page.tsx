"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AggregatePanel, {
  type AggregateRow,
} from "../components/AggregatePanel";

interface RecentRow {
  run_id: string;
  prompt_text: string;
  started_at: number;
  finished_at: number | null;
  total_tokens: number;
  stopped_reason: string | null;
}

/** Backend payload from GET /probes/aggregate. The server tallies how
 *  many runs each (layer, feature_id) appeared in each phase-exclusive
 *  list, sorted by hits desc with avg-value as tiebreaker. */
interface AggregatePayload {
  total_runs: number;
  min_hits: number;
  // Backend uses different value-key names per column to make the math
  // self-documenting, but in the UI we normalize both into AggregateRow's
  // `avg_value` field below.
  thinking_only: Array<
    Omit<AggregateRow, "avg_value"> & { avg_delta: number }
  >;
  output_only: Array<
    Omit<AggregateRow, "avg_value"> & { avg_output_mean: number }
  >;
}

const API =
  typeof window !== "undefined"
    ? process.env.NEXT_PUBLIC_API_BASE ??
      `${window.location.protocol}//${window.location.hostname}:8000`
    : process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export default function ArchivePage() {
  const [rows, setRows] = useState<RecentRow[] | null>(null);
  const [agg, setAgg] = useState<AggregatePayload | null>(null);

  useEffect(() => {
    fetch(`${API}/probes/recent`)
      .then((r) => r.json())
      .then(setRows)
      .catch(() => setRows([]));
    fetch(`${API}/probes/aggregate`)
      .then((r) => r.json())
      .then(setAgg)
      .catch(() => setAgg({ total_runs: 0, min_hits: 2, thinking_only: [], output_only: [] }));
  }, []);

  // Normalize backend rows to AggregateRow shape (rename per-column avg
  // field to a single `avg_value` so AggregatePanel doesn't need to know
  // which column it's rendering).
  const thinkingRows: AggregateRow[] =
    agg?.thinking_only.map((r) => ({
      layer: r.layer,
      feature_id: r.feature_id,
      hits: r.hits,
      total_runs: r.total_runs,
      avg_value: r.avg_delta,
      label: r.label,
      label_model: r.label_model,
    })) ?? [];
  const outputRows: AggregateRow[] =
    agg?.output_only.map((r) => ({
      layer: r.layer,
      feature_id: r.feature_id,
      hits: r.hits,
      total_runs: r.total_runs,
      avg_value: r.avg_output_mean,
      label: r.label,
      label_model: r.label_model,
    })) ?? [];

  const enoughData = agg && agg.total_runs >= 2;

  return (
    <div className="flex-1 px-6 py-8 max-w-6xl mx-auto w-full">
      <h1 className="font-display text-2xl text-amber amber-glow mb-2">Archive</h1>
      <p className="text-text-dim text-xs mb-8 italic">
        Past interrogations and the patterns that recur across them.
      </p>

      {/* ===== Cross-run aggregate section ===== */}
      <section className="mb-12">
        <header className="border-b border-rule pb-2 mb-4 flex items-baseline justify-between">
          <div>
            <div className="font-display text-xs text-amber tracking-widest">
              patterns across all runs
            </div>
            <div className="text-[10px] text-text-dim italic mt-0.5">
              Features that consistently appear in the phase-exclusive lists
              across multiple probes. Ranked by frequency (how many runs the
              feature was hidden in), then average strength when it appeared.
            </div>
          </div>
          <div className="font-mono text-[10px] text-text-dim">
            {agg?.total_runs ?? "…"} runs · min {agg?.min_hits ?? 2} occurrences
          </div>
        </header>

        {!agg && (
          <div className="text-text-dim text-xs italic px-3 py-6">
            loading aggregate…
          </div>
        )}

        {agg && !enoughData && (
          <div className="text-text-dim text-xs italic px-3 py-6 border border-rule bg-bg-soft">
            Need at least 2 completed runs before cross-run patterns are
            meaningful. Currently: {agg.total_runs}.
          </div>
        )}

        {enoughData && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-rule border border-rule">
            <AggregatePanel
              title="Recurring Hidden Thoughts"
              subtitle="Features the model has thought-but-not-said most often across all runs."
              accent="text-amber"
              barColor="rgba(232,195,130,0.6)"
              rows={thinkingRows}
            />
            <AggregatePanel
              title="Recurring Surface-Only Concepts"
              subtitle="Features that appeared in answers without showing up in the reasoning, across multiple runs."
              accent="text-cyan"
              barColor="rgba(94,229,229,0.55)"
              rows={outputRows}
            />
          </div>
        )}
      </section>

      {/* ===== Per-run list ===== */}
      <section>
        <header className="border-b border-rule pb-2 mb-4">
          <div className="font-display text-xs text-amber tracking-widest">
            individual runs
          </div>
          <div className="text-[10px] text-text-dim italic mt-0.5">
            Each entry is one probe; click to revisit its verdict.
          </div>
        </header>

        {rows === null && <div className="text-text-dim">loading…</div>}
        {rows && rows.length === 0 && (
          <div className="text-text-dim italic">No probes recorded yet.</div>
        )}

        <ul className="flex flex-col gap-2">
          {rows?.map((r) => (
            <li key={r.run_id}>
              <Link
                href={`/verdict/${r.run_id}`}
                className="block border border-rule p-3 hover:border-amber-dim transition-colors"
              >
                <div className="flex justify-between items-start gap-4">
                  <div className="flex-1 text-xs">
                    <div className="text-amber font-mono line-clamp-2">
                      {r.prompt_text}
                    </div>
                    <div className="text-text-dim text-[10px] mt-1">
                      {new Date(r.started_at * 1000).toLocaleString()} ·{" "}
                      {r.total_tokens} tokens
                      {r.stopped_reason && <> · {r.stopped_reason}</>}
                    </div>
                  </div>
                  <div className="text-text-dim text-[10px] font-mono">
                    {r.run_id}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
