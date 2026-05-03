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

interface RecentPage {
  rows: RecentRow[];
  total: number;
  limit: number;
  offset: number;
}

const PAGE_SIZE = 10;

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
  const [page, setPage] = useState<RecentPage | null>(null);
  const [pageIndex, setPageIndex] = useState(0); // 0-based
  const [agg, setAgg] = useState<AggregatePayload | null>(null);

  useEffect(() => {
    const offset = pageIndex * PAGE_SIZE;
    fetch(`${API}/probes/recent?limit=${PAGE_SIZE}&offset=${offset}`)
      .then((r) => r.json())
      .then((p: RecentPage) => setPage(p))
      .catch(() =>
        setPage({ rows: [], total: 0, limit: PAGE_SIZE, offset: 0 }),
      );
  }, [pageIndex]);

  // Aggregate fetched once on mount; doesn't depend on per-run page.
  useEffect(() => {
    fetch(`${API}/probes/aggregate`)
      .then((r) => r.json())
      .then(setAgg)
      .catch(() =>
        setAgg({
          total_runs: 0,
          min_hits: 2,
          thinking_only: [],
          output_only: [],
        }),
      );
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

      {/* ===== Per-run list (paginated, 10 per page) ===== */}
      <PerRunList
        page={page}
        pageIndex={pageIndex}
        setPageIndex={setPageIndex}
      />
    </div>
  );
}

function PerRunList({
  page,
  pageIndex,
  setPageIndex,
}: {
  page: RecentPage | null;
  pageIndex: number;
  setPageIndex: (n: number) => void;
}) {
  const total = page?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstIndex = pageIndex * PAGE_SIZE;
  const lastIndex = Math.min(total, firstIndex + (page?.rows.length ?? 0));
  const onFirstPage = pageIndex === 0;
  const onLastPage = pageIndex >= totalPages - 1;

  return (
    <section>
      <header className="border-b border-rule pb-2 mb-4 flex items-baseline justify-between">
        <div>
          <div className="font-display text-xs text-amber tracking-widest">
            individual runs
          </div>
          <div className="text-[10px] text-text-dim italic mt-0.5">
            Each entry is one probe; click to revisit its verdict.
          </div>
        </div>
        {total > 0 && (
          <div className="font-mono text-[10px] text-text-dim">
            {firstIndex + 1}–{lastIndex} of {total}
          </div>
        )}
      </header>

      {page === null && <div className="text-text-dim">loading…</div>}
      {page && page.rows.length === 0 && pageIndex === 0 && (
        <div className="text-text-dim italic">No probes recorded yet.</div>
      )}

      <ul className="flex flex-col gap-2">
        {page?.rows.map((r) => (
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

      {/* Page controls — only render when there's more than one page */}
      {total > PAGE_SIZE && (
        <nav className="flex items-center justify-between mt-5 pt-3 border-t border-rule">
          <button
            type="button"
            onClick={() => setPageIndex(Math.max(0, pageIndex - 1))}
            disabled={onFirstPage}
            className="font-display text-[10px] tracking-widest px-3 py-1.5 border border-amber-dim text-amber hover:bg-amber hover:text-bg disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-amber disabled:cursor-not-allowed transition-colors"
          >
            ← prev
          </button>
          <PageNumbers
            current={pageIndex}
            total={totalPages}
            onPick={setPageIndex}
          />
          <button
            type="button"
            onClick={() =>
              setPageIndex(Math.min(totalPages - 1, pageIndex + 1))
            }
            disabled={onLastPage}
            className="font-display text-[10px] tracking-widest px-3 py-1.5 border border-amber-dim text-amber hover:bg-amber hover:text-bg disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-amber disabled:cursor-not-allowed transition-colors"
          >
            next →
          </button>
        </nav>
      )}
    </section>
  );
}

/** Compact page-number list: shows the current page in context. With
 *  many pages we ellipsize the middle so the strip stays readable
 *  ([1] 2 3 ... 18 [19] 20  for 20 pages, current page 19). */
function PageNumbers({
  current,
  total,
  onPick,
}: {
  current: number;
  total: number;
  onPick: (n: number) => void;
}) {
  const pages: (number | "…")[] = [];
  if (total <= 7) {
    for (let i = 0; i < total; i++) pages.push(i);
  } else {
    pages.push(0);
    if (current > 2) pages.push("…");
    const lo = Math.max(1, current - 1);
    const hi = Math.min(total - 2, current + 1);
    for (let i = lo; i <= hi; i++) pages.push(i);
    if (current < total - 3) pages.push("…");
    pages.push(total - 1);
  }
  return (
    <div className="flex items-center gap-1 font-mono text-[11px]">
      {pages.map((p, i) =>
        p === "…" ? (
          <span key={`g${i}`} className="text-text-dim/60 px-1">
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            className={`min-w-[1.75rem] px-1.5 py-1 border transition-colors ${
              p === current
                ? "border-amber bg-amber/15 text-amber"
                : "border-rule text-text-dim hover:border-amber-dim hover:text-amber-dim"
            }`}
          >
            {p + 1}
          </button>
        ),
      )}
    </div>
  );
}
