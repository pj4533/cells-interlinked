"use client";

/**
 * /journal — local-only CRM for journal entries.
 *
 * Three sections:
 *   1. Header: "Generate analysis" button + analyzer status strip + range
 *      selector ("since last published" | "last N days" | custom)
 *   2. Pending drafts (status='pending') with Review / Publish / Reject /
 *      Delete buttons. Clicking Review opens a modal showing the full
 *      markdown body so the user can read before publishing.
 *   3. Published history (status='published') with link to the public site.
 *
 * Polling: when an analyzer run is in flight, /journal/status is polled
 * every 2s. Otherwise, polls every 15s as a low-rate sanity check.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const API =
  typeof window !== "undefined"
    ? process.env.NEXT_PUBLIC_API_BASE ??
      `${window.location.protocol}//${window.location.hostname}:8000`
    : process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

interface AnalysisRow {
  id: number;
  status: string;
  title: string;
  slug: string;
  summary: string;
  range_start: number;
  range_end: number;
  runs_included: number;
  model: string;
  created_at: number;
  published_at: number | null;
}

interface AnalysisFull extends AnalysisRow {
  body_markdown: string;
  metadata?: Record<string, unknown>;
}

interface AnalyzerStatus {
  running: boolean;
  mode: "draft" | "revise" | null;
  started_at: number | null;
  finished_at: number | null;
  last_id: number | null;
  last_error: string | null;
  model: string;
}

interface WindowStats {
  range_start: number;
  range_end: number;
  total_finished: number;
  in_flight: number;
  baseline_finished: number;
  hinted_finished: number;
  agent_finished: number;
  abliterated_finished: number;
  by_hint_kind: Record<string, number>;
}

const RANGES: Array<{ label: string; days: number | null }> = [
  { label: "since last publish", days: null },
  { label: "last 24 h", days: 1 },
  { label: "last 3 days", days: 3 },
  { label: "last 7 days", days: 7 },
  { label: "last 30 days", days: 30 },
];

export default function JournalPage() {
  const [analyzer, setAnalyzer] = useState<AnalyzerStatus | null>(null);
  const [pending, setPending] = useState<AnalysisRow[]>([]);
  const [published, setPublished] = useState<AnalysisRow[]>([]);
  const [reviewing, setReviewing] = useState<AnalysisFull | null>(null);
  const [rangeIdx, setRangeIdx] = useState(0);
  const [hint, setHint] = useState("");
  const [windowStats, setWindowStats] = useState<WindowStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Last publish result — surfaces git status (committed/pushed/log)
  // from the publisher so a silent gitignore-no-op doesn't disappear
  // into the void. Cleared on next publish or on dismiss.
  const [publishResult, setPublishResult] = useState<{
    title: string;
    slug: string;
    committed: boolean;
    pushed: boolean;
    log: string;
    raw: unknown;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const range = RANGES[rangeIdx];
      const statsParams = new URLSearchParams();
      if (range.days !== null) {
        statsParams.set(
          "since",
          String(Date.now() / 1000 - range.days * 86400),
        );
      }
      const statsUrl = `${API}/journal/window-stats${
        statsParams.toString() ? `?${statsParams}` : ""
      }`;
      const [s, p, q, w] = await Promise.all([
        fetch(`${API}/journal/status`).then((r) => r.json()),
        fetch(`${API}/journal/pending`).then((r) => r.json()),
        fetch(`${API}/journal/published`).then((r) => r.json()),
        fetch(statsUrl).then((r) => r.json()),
      ]);
      setAnalyzer(s);
      setPending(p.rows ?? []);
      setPublished(q.rows ?? []);
      setWindowStats(w as WindowStats);
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [rangeIdx]);

  useEffect(() => {
    refresh();
    const tick = setInterval(
      refresh,
      analyzer?.running ? 2000 : 15000,
    );
    return () => clearInterval(tick);
  }, [refresh, analyzer?.running]);

  const onAnalyze = async () => {
    if (busy || analyzer?.running) return;
    setBusy(true);
    try {
      const range = RANGES[rangeIdx];
      const body: { since?: number; until?: number; hint?: string } = {};
      if (range.days !== null) {
        body.since = Date.now() / 1000 - range.days * 86400;
      }
      const trimmedHint = hint.trim();
      if (trimmedHint) body.hint = trimmedHint;
      await fetch(`${API}/journal/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const onRevise = async (id: number, instruction: string) => {
    if (busy || analyzer?.running) return;
    const trimmed = instruction.trim();
    if (!trimmed) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const resp = await fetch(`${API}/journal/revise/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: trimmed }),
      }).then((r) => r.json());
      if (!resp.ok) {
        setErrorMsg(resp.reason || resp.detail || "revise failed");
      }
      await refresh();
      setReviewing(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onReview = async (id: number) => {
    const full = await fetch(`${API}/journal/${id}`).then((r) => r.json());
    setReviewing(full);
  };

  const onPublish = async (id: number) => {
    setBusy(true);
    setPublishResult(null);
    const draftTitle = reviewing?.title || `#${id}`;
    try {
      const result = await fetch(`${API}/journal/publish/${id}`, {
        method: "POST",
      }).then((r) => r.json());
      if (!result.ok) {
        setErrorMsg(result.detail || "publish failed");
      } else {
        const fx = result.side_effects || {};
        const git = fx.git || {};
        setPublishResult({
          title: draftTitle,
          slug: fx.slug || "",
          committed: !!git.committed,
          pushed: !!git.pushed,
          log: git.log || "(no git output)",
          raw: result,
        });
      }
      await refresh();
      setReviewing(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onReject = async (id: number) => {
    await fetch(`${API}/journal/reject/${id}`, { method: "POST" });
    await refresh();
    setReviewing(null);
  };

  const onDelete = async (id: number) => {
    if (!confirm("Delete this draft permanently?")) return;
    await fetch(`${API}/journal/${id}`, { method: "DELETE" });
    await refresh();
    setReviewing(null);
  };

  return (
    <div className="flex-1 px-6 py-8 max-w-6xl mx-auto w-full">
      <h1 className="font-display text-2xl text-amber amber-glow mb-2">
        Journal
      </h1>
      <p className="text-text-dim text-xs italic mb-6">
        Drafts written by the frontier analyzer over recent autorun
        activity. Review locally; publish to push to the public site.
      </p>

      {/* ===== Generate strip ===== */}
      <section className="mb-8 border border-rule bg-bg-soft p-5">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <button
              data-vk
              type="button"
              onClick={onAnalyze}
              disabled={busy || analyzer?.running}
            >
              {analyzer?.running
                ? analyzer.mode === "revise"
                  ? "revising…"
                  : "drafting…"
                : "draft new entry"}
            </button>

            <div className="flex flex-col gap-1">
              <label className="text-[9px] text-text-dim font-mono tracking-widest uppercase">
                window
              </label>
              <select
                value={rangeIdx}
                onChange={(e) => setRangeIdx(Number(e.target.value))}
                disabled={analyzer?.running}
                className="bg-bg border border-rule text-text px-2 py-1 text-xs font-mono focus:border-amber-dim focus:outline-none"
              >
                {RANGES.map((r, i) => (
                  <option key={r.label} value={i}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <AnalyzerStatusCell status={analyzer} />
        </div>

        {windowStats && (
          <WindowStatsLine
            stats={windowStats}
            rangeLabel={RANGES[rangeIdx].label}
          />
        )}

        <div className="mt-4 flex flex-col gap-1">
          <label
            htmlFor="journal-hint"
            className="text-[9px] text-text-dim font-mono tracking-widest uppercase"
          >
            optional hint — steers Opus for this draft only
          </label>
          <textarea
            id="journal-hint"
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            disabled={analyzer?.running}
            rows={2}
            placeholder="e.g. we added abliteration since last entry — focus on what changed in the matched-prompt regime shifts"
            className="bg-bg border border-rule text-text px-2 py-1 text-xs font-mono leading-relaxed focus:border-amber-dim focus:outline-none placeholder:text-text-dim/50 resize-y"
          />
        </div>

        {analyzer?.last_error && (
          <div className="mt-4 text-warning text-xs font-mono italic">
            last error: {analyzer.last_error}
          </div>
        )}
        {errorMsg && (
          <div className="mt-4 text-warning text-xs font-mono italic">
            {errorMsg}
          </div>
        )}
      </section>

      {publishResult && (
        <PublishResultBanner
          result={publishResult}
          onDismiss={() => setPublishResult(null)}
        />
      )}

      {/* ===== Pending drafts ===== */}
      <section className="mb-12">
        <SectionHeader
          title="pending drafts"
          subtitle="Awaiting review. Read first; only publish what's worth shipping."
          count={pending.length}
        />
        {pending.length === 0 ? (
          <div className="text-text-dim italic text-xs px-3 py-6 border border-rule bg-bg-soft">
            No drafts in review. Use &ldquo;draft new entry&rdquo; to create one.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {pending.map((r) => (
              <AnalysisCard
                key={r.id}
                row={r}
                actionsRight={
                  <>
                    <button
                      type="button"
                      onClick={() => onReview(r.id)}
                      className="font-display text-[10px] tracking-widest px-3 py-1.5 border border-amber-dim text-amber hover:bg-amber hover:text-bg transition-colors"
                    >
                      review
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(r.id)}
                      className="font-display text-[10px] tracking-widest px-2 py-1.5 border border-rule text-text-dim hover:border-warning hover:text-warning transition-colors"
                    >
                      delete
                    </button>
                  </>
                }
              />
            ))}
          </ul>
        )}
      </section>

      {/* ===== Published ===== */}
      <section>
        <SectionHeader
          title="published"
          subtitle="Live on the public site. Most recent first."
          count={published.length}
        />
        {published.length === 0 ? (
          <div className="text-text-dim italic text-xs px-3 py-6 border border-rule bg-bg-soft">
            No published reports yet.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {published.map((r) => (
              <AnalysisCard
                key={r.id}
                row={r}
                actionsRight={
                  <button
                    type="button"
                    onClick={() => onReview(r.id)}
                    className="font-display text-[10px] tracking-widest px-3 py-1.5 border border-rule text-text-dim hover:border-amber-dim hover:text-amber transition-colors"
                  >
                    re-read
                  </button>
                }
              />
            ))}
          </ul>
        )}
      </section>

      {reviewing && (
        <ReviewModal
          analysis={reviewing}
          onClose={() => setReviewing(null)}
          onPublish={() => onPublish(reviewing.id)}
          onReject={() => onReject(reviewing.id)}
          onDelete={() => onDelete(reviewing.id)}
          onRevise={(instruction) => onRevise(reviewing.id, instruction)}
          busy={busy}
          analyzerRunning={!!analyzer?.running}
        />
      )}
    </div>
  );
}

function PublishResultBanner({
  result,
  onDismiss,
}: {
  result: {
    title: string;
    slug: string;
    committed: boolean;
    pushed: boolean;
    log: string;
  };
  onDismiss: () => void;
}) {
  // Three states:
  //   pushed       → green-ish "live on Vercel in ~25s"
  //   committed    → committed but push failed (network, auth, etc.)
  //   neither      → wrote files but git did nothing (gitignore? slug clash?)
  const ok = result.pushed;
  const partial = result.committed && !result.pushed;
  const headline = ok
    ? "PUBLISHED"
    : partial
      ? "COMMITTED — PUSH FAILED"
      : "WROTE FILES — NO GIT COMMIT";
  const accent = ok ? "text-cyan" : partial ? "text-amber" : "text-warning";
  const subline = ok
    ? "Vercel will rebuild and the report will be live at cells-interlinked.vercel.app in ~25s."
    : partial
      ? "The commit is local. Run `git push` from the repo to deploy."
      : "Files were written but git skipped them — likely a .gitignore match. Run `git status journal/` to investigate.";
  return (
    <section className="mb-10 border border-rule bg-bg-soft p-5">
      <div className="flex items-baseline justify-between mb-2">
        <div className={`font-display text-sm tracking-widest ${accent}`}>
          {headline}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-text-dim hover:text-amber font-mono text-xs"
        >
          dismiss ×
        </button>
      </div>
      <div className="text-text text-xs italic mb-2 font-prose">
        &ldquo;{result.title}&rdquo; → <code className="text-amber-dim">{result.slug}</code>
      </div>
      <div className="text-text-dim text-[11px] mb-3 font-prose italic">
        {subline}
      </div>
      <details className="text-[10px]">
        <summary className="cursor-pointer text-text-dim hover:text-amber-dim font-mono tracking-widest uppercase">
          git transcript
        </summary>
        <pre className="mt-2 p-3 bg-bg border border-rule font-mono text-[10px] text-text-dim whitespace-pre-wrap">
          {result.log}
        </pre>
      </details>
    </section>
  );
}

function WindowStatsLine({
  stats,
  rangeLabel,
}: {
  stats: WindowStats;
  rangeLabel: string;
}) {
  // What the analyzer will see when "draft new entry" is clicked.
  // Two studies share this regime breakdown:
  //   - Hinted study: matched-pair shifts need baseline + hinted in window
  //   - Agent study: matched-pair shifts need baseline + agent in window
  // We surface each study's availability separately so the operator
  // sees at a glance which matched analyses will be computable.
  const allKinds = Object.entries(stats.by_hint_kind).sort(
    (a, b) => b[1] - a[1],
  );
  const hintKinds = allKinds.filter(([k]) => !k.startsWith("agent:"));
  const agentKinds = allKinds.filter(([k]) => k.startsWith("agent:"));
  const hintMatchAvailable =
    stats.baseline_finished > 0 && stats.hinted_finished > 0;
  const agentMatchAvailable =
    stats.baseline_finished > 0 && stats.agent_finished > 0;
  const noScaffolded =
    stats.hinted_finished === 0 && stats.agent_finished === 0;
  return (
    <div className="mt-4 pt-3 border-t border-rule/40">
      <div className="text-[9px] text-text-dim font-mono tracking-widest uppercase mb-1">
        analyzer will see · {rangeLabel}
      </div>
      <div className="font-mono text-[11px] text-text leading-relaxed">
        <span className="text-amber font-display tracking-widest">
          {stats.total_finished}
        </span>{" "}
        finished run{stats.total_finished === 1 ? "" : "s"}
        {stats.in_flight > 0 && (
          <span className="text-text-dim/70">
            {" "}
            · {stats.in_flight} in flight
          </span>
        )}
        <span className="text-text-dim"> · </span>
        <span className={stats.baseline_finished > 0 ? "text-text" : "text-text-dim/50"}>
          {stats.baseline_finished} baseline
        </span>
        <span className="text-text-dim"> · </span>
        <span className={stats.hinted_finished > 0 ? "text-cyan" : "text-text-dim/50"}>
          {stats.hinted_finished} hinted
        </span>
        <span className="text-text-dim"> · </span>
        <span className={stats.agent_finished > 0 ? "text-amber" : "text-text-dim/50"}>
          {stats.agent_finished} agent
        </span>
        {stats.abliterated_finished > 0 && (
          <>
            <span className="text-text-dim"> · </span>
            <span className="text-cyan-dim">
              {stats.abliterated_finished} abliterated
            </span>
          </>
        )}
      </div>
      {hintKinds.length > 0 && (
        <div className="font-mono text-[10px] text-text-dim mt-1.5">
          <span className="text-cyan-dim">hint families:</span>{" "}
          {hintKinds.map(([kind, n], i) => (
            <span key={kind}>
              {i > 0 && <span className="text-text-dim/40"> · </span>}
              <span className="text-cyan">{n}</span> <span>{kind}</span>
            </span>
          ))}
        </div>
      )}
      {agentKinds.length > 0 && (
        <div className="font-mono text-[10px] text-text-dim mt-1">
          <span className="text-amber-dim">agent families:</span>{" "}
          {agentKinds.map(([kind, n], i) => (
            <span key={kind}>
              {i > 0 && <span className="text-text-dim/40"> · </span>}
              <span className="text-amber">{n}</span>{" "}
              <span>{kind.replace(/^agent:/, "")}</span>
            </span>
          ))}
        </div>
      )}
      {stats.total_finished > 0 && stats.hinted_finished > 0 && !hintMatchAvailable && (
        <div className="font-mono text-[10px] text-warning/70 italic mt-1.5">
          hint matched-pair shifts unavailable: no baseline runs in window
        </div>
      )}
      {stats.total_finished > 0 && stats.agent_finished > 0 && !agentMatchAvailable && (
        <div className="font-mono text-[10px] text-warning/70 italic mt-1.5">
          agent matched-pair shifts unavailable: no baseline runs in window
        </div>
      )}
      {stats.total_finished > 0 &&
        stats.baseline_finished > 0 &&
        noScaffolded && (
          <div className="font-mono text-[10px] text-text-dim/70 italic mt-1.5">
            only baseline in window — no matched-pair shifts; analyzer will
            still compare against the prior archive
          </div>
        )}
      {stats.total_finished === 0 && (
        <div className="font-mono text-[10px] text-warning/70 italic mt-1">
          window is empty — analyzer will refuse to draft
        </div>
      )}
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
  count,
}: {
  title: string;
  subtitle: string;
  count: number;
}) {
  return (
    <header className="border-b border-rule pb-2 mb-4 flex items-baseline justify-between">
      <div>
        <div className="font-display text-xs text-amber tracking-widest">
          {title}
        </div>
        <div className="text-[10px] text-text-dim italic mt-0.5">{subtitle}</div>
      </div>
      <div className="font-mono text-[10px] text-text-dim">
        {count} {count === 1 ? "entry" : "entries"}
      </div>
    </header>
  );
}

function AnalyzerStatusCell({ status }: { status: AnalyzerStatus | null }) {
  if (!status) return null;
  const statePill = status.running ? (
    <span className="font-display text-xs text-cyan cyan-glow tracking-widest">
      {status.mode === "revise" ? "REVISING" : "RUNNING"}
    </span>
  ) : status.last_error ? (
    <span className="font-display text-xs text-warning tracking-widest">
      ERROR
    </span>
  ) : status.last_id ? (
    <span className="font-display text-xs text-amber-dim tracking-widest">
      IDLE
    </span>
  ) : (
    <span className="font-display text-xs text-text-dim tracking-widest">
      IDLE
    </span>
  );
  return (
    <div className="text-right text-[10px] font-mono text-text-dim">
      <div className="flex items-center gap-2 justify-end">
        analyzer · {statePill}
      </div>
      <div className="mt-0.5">
        {status.model}
        {status.finished_at && !status.running && (
          <> · last finished {formatRelative(status.finished_at)}</>
        )}
        {status.started_at && status.running && (
          <> · started {formatRelative(status.started_at)}</>
        )}
      </div>
    </div>
  );
}

function AnalysisCard({
  row,
  actionsRight,
}: {
  row: AnalysisRow;
  actionsRight: React.ReactNode;
}) {
  return (
    <li className="border border-rule p-4 flex items-start justify-between gap-4">
      <div className="flex-1">
        <div className="font-display text-sm text-amber tracking-wide mb-1">
          {row.title}
        </div>
        <div className="text-text text-xs italic mb-2">{row.summary}</div>
        <div className="text-text-dim text-[10px] font-mono space-x-2">
          <span>{row.runs_included} runs</span>
          <span>·</span>
          <span>{formatRange(row.range_start, row.range_end)}</span>
          <span>·</span>
          <span>{row.model}</span>
          {row.published_at && (
            <>
              <span>·</span>
              <span className="text-cyan-dim">
                published {formatRelative(row.published_at)}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">{actionsRight}</div>
    </li>
  );
}

function ReviewModal({
  analysis,
  onClose,
  onPublish,
  onReject,
  onDelete,
  onRevise,
  busy,
  analyzerRunning,
}: {
  analysis: AnalysisFull;
  onClose: () => void;
  onPublish: () => void;
  onReject: () => void;
  onDelete: () => void;
  onRevise: (instruction: string) => void;
  busy: boolean;
  analyzerRunning: boolean;
}) {
  const isPending = analysis.status === "pending";
  const [revision, setRevision] = useState("");
  const reviseDisabled =
    busy || analyzerRunning || revision.trim().length === 0;
  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/85 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div
        className="bg-bg-soft border border-amber-dim max-w-3xl w-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-6 py-4 border-b border-rule flex items-center justify-between shrink-0">
          <div>
            <div className="font-display text-lg text-amber amber-glow">
              {analysis.title}
            </div>
            <div className="text-text-dim text-[10px] font-mono mt-1">
              slug: <span className="text-amber-dim">{analysis.slug}</span>
              {" · "}
              {analysis.runs_included} runs
              {" · "}
              {analysis.model}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-text-dim hover:text-amber font-mono text-xs"
          >
            close ×
          </button>
        </header>

        <article className="flex-1 overflow-y-auto px-6 py-5 prose-vk">
          <pre className="whitespace-pre-wrap text-text text-sm font-mono leading-relaxed">
            {analysis.body_markdown}
          </pre>
        </article>

        {isPending && (
          <div className="px-6 py-4 border-t border-rule shrink-0 bg-bg/40">
            <div className="flex items-baseline justify-between mb-2">
              <label
                htmlFor="revise-instruction"
                className="text-[9px] text-text-dim font-mono tracking-widest uppercase"
              >
                revise — ask Opus for fixes instead of hand-editing
              </label>
              <span className="text-[9px] text-text-dim font-mono italic">
                regenerates this draft in place; metadata preserved
              </span>
            </div>
            <textarea
              id="revise-instruction"
              value={revision}
              onChange={(e) => setRevision(e.target.value)}
              disabled={busy || analyzerRunning}
              rows={3}
              placeholder="e.g. tighten the opening paragraph, drop the sci-fi metaphor in section 2, lean harder on the matched-prompt shift on prompt #4"
              className="w-full bg-bg border border-rule text-text px-2 py-1 text-xs font-mono leading-relaxed focus:border-amber-dim focus:outline-none placeholder:text-text-dim/50 resize-y"
            />
            <div className="mt-2 flex items-center justify-end">
              <button
                type="button"
                onClick={() => {
                  onRevise(revision);
                  setRevision("");
                }}
                disabled={reviseDisabled}
                className="font-display text-[10px] tracking-widest px-3 py-1.5 border border-amber-dim text-amber hover:bg-amber hover:text-bg disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-amber transition-colors"
              >
                {analyzerRunning ? "analyzer busy…" : "ask Opus to revise"}
              </button>
            </div>
          </div>
        )}

        <footer className="px-6 py-4 border-t border-rule flex items-center justify-between shrink-0">
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="font-display text-[10px] tracking-widest px-3 py-1.5 border border-rule text-text-dim hover:border-warning hover:text-warning disabled:opacity-30 transition-colors"
          >
            delete
          </button>
          <div className="flex items-center gap-3">
            {isPending && (
              <button
                type="button"
                onClick={onReject}
                disabled={busy}
                className="font-display text-[10px] tracking-widest px-3 py-1.5 border border-rule text-text-dim hover:border-amber-dim hover:text-amber disabled:opacity-30 transition-colors"
              >
                reject
              </button>
            )}
            {isPending && (
              <button
                data-vk
                type="button"
                onClick={onPublish}
                disabled={busy}
              >
                {busy ? "publishing…" : "publish"}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function formatRelative(ts: number): string {
  const seconds = Math.floor(Date.now() / 1000 - ts);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatRange(start: number, end: number): string {
  const fmt = (ts: number) =>
    new Date(ts * 1000).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  return `${fmt(start)} → ${fmt(end)}`;
}
