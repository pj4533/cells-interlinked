"use client";

/**
 * /autorun — control panel for the continuous interrogation loop.
 *
 * Pure client-rendered, polls /autorun/status every 3s while the tab is
 * focused. Polling pauses when the tab is hidden so we don't spin a
 * background tab forever.
 *
 * Visual hierarchy is:
 *   1. ACTIVE/IDLE state strip (top — biggest type)
 *   2. Toggle button + current probe + queue counts
 *   3. Three columns: live log | queue preview | proposer
 *   4. Recent autorun runs list (links into /verdict)
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

const API =
  typeof window !== "undefined"
    ? process.env.NEXT_PUBLIC_API_BASE ??
      `${window.location.protocol}//${window.location.hostname}:8000`
    : process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

const POLL_INTERVAL_MS = 3000;

interface AutorunStatus {
  running: boolean;
  stop_requested: boolean;
  current_run_id: string | null;
  proposer: {
    state: "idle" | "running" | "failed";
    started_at: number | null;
    finished_at: number | null;
    last_count: number;
    last_error: string | null;
  };
  recent_log: Array<{
    ts: number;
    kind: string;
    message: string;
    run_id: string | null;
    source: string | null;
  }>;
  queue: {
    curated_remaining: number;
    generated_remaining: number;
    total_remaining: number;
  };
  queue_preview: Array<{
    prompt_text: string;
    source: string;
    rationale?: string;
  }>;
  persistent: {
    running: number;
    last_change_at: number;
    total_runs: number;
    last_run_id: string | null;
    last_event: string | null;
  };
  config: {
    interval_sec: number;
    trigger_depth: number;
    batch_size: number;
  };
}

interface RecentRow {
  run_id: string;
  prompt_text: string;
  started_at: number;
  finished_at: number | null;
  total_tokens: number;
  stopped_reason: string | null;
  source: string;
  proposer_run_id: number | null;
}

export default function AutorunPage() {
  const [status, setStatus] = useState<AutorunStatus | null>(null);
  const [recent, setRecent] = useState<RecentRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const lastPollRef = useRef<number>(0);

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([
        fetch(`${API}/autorun/status`).then((x) => x.json()),
        fetch(`${API}/autorun/recent?limit=20`).then((x) => x.json()),
      ]);
      setStatus(s);
      setRecent(r.rows ?? []);
      setPollError(null);
      lastPollRef.current = Date.now();
    } catch (err) {
      setPollError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      // Skip polling when the tab is hidden — no point updating a UI
      // nobody's looking at, and reduces API load while autorun is the
      // only consumer. Resumes immediately on visibility change below.
      if (document.visibilityState === "visible") {
        refresh();
      }
    }, POLL_INTERVAL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);

  const onToggle = async () => {
    if (!status || busy) return;
    setBusy(true);
    try {
      const endpoint = status.running ? "/autorun/stop" : "/autorun/start";
      await fetch(`${API}${endpoint}`, { method: "POST" });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <div className="flex-1 px-6 py-8 max-w-6xl mx-auto w-full">
        <h1 className="font-display text-2xl text-amber amber-glow mb-2">
          Autorun
        </h1>
        <p className="text-text-dim text-xs italic mb-8">
          Continuous interrogation loop.
        </p>
        <div className="text-text-dim text-xs italic px-3 py-6">
          {pollError ? `connection failed — ${pollError}` : "loading…"}
        </div>
      </div>
    );
  }

  const running = status.running;
  const stopping = status.running && status.stop_requested;

  return (
    <div className="flex-1 px-6 py-8 max-w-6xl mx-auto w-full">
      <h1 className="font-display text-2xl text-amber amber-glow mb-2">
        Autorun
      </h1>
      <p className="text-text-dim text-xs italic mb-6">
        Continuous interrogation loop. Picks the next unrun probe, runs it
        through the model, repeats. When the curated probes are exhausted,
        a separate proposer subprocess generates fresh ones from recent
        runs.
      </p>

      {/* ===== Status strip ===== */}
      <section className="mb-6">
        <StatusStrip
          running={running}
          stopping={stopping ?? false}
          currentRunId={status.current_run_id}
          totalRuns={status.persistent.total_runs}
          intervalSec={status.config.interval_sec}
        />
      </section>

      {/* ===== Toggle + queue counts ===== */}
      <section className="mb-8 grid grid-cols-1 md:grid-cols-[auto_1fr] gap-6 items-center">
        <button
          data-vk
          type="button"
          onClick={onToggle}
          disabled={busy}
          className={running ? "autorun-btn-running" : ""}
          style={
            running
              ? {
                  borderColor: "var(--cyan-dim)",
                  color: "var(--cyan)",
                  boxShadow: "0 0 24px rgba(94, 229, 229, 0.25)",
                }
              : undefined
          }
        >
          {busy ? "…" : running ? "Halt" : "Begin Autorun"}
        </button>

        <QueueCounts
          curated={status.queue.curated_remaining}
          generated={status.queue.generated_remaining}
          triggerDepth={status.config.trigger_depth}
        />
      </section>

      {/* ===== Three-pane: live log | queue preview | proposer ===== */}
      <section className="mb-10 grid grid-cols-1 md:grid-cols-3 gap-px bg-rule border border-rule">
        <LiveLog events={status.recent_log} />
        <QueuePreview items={status.queue_preview} />
        <ProposerStatus
          state={status.proposer.state}
          startedAt={status.proposer.started_at}
          finishedAt={status.proposer.finished_at}
          lastCount={status.proposer.last_count}
          lastError={status.proposer.last_error}
          batchSize={status.config.batch_size}
        />
      </section>

      {/* ===== Recent autorun runs ===== */}
      <RecentRuns rows={recent} />

      {pollError && (
        <div className="mt-6 text-warning text-[10px] font-mono italic">
          last poll failed: {pollError}
        </div>
      )}
    </div>
  );
}

function StatusStrip({
  running,
  stopping,
  currentRunId,
  totalRuns,
  intervalSec,
}: {
  running: boolean;
  stopping: boolean;
  currentRunId: string | null;
  totalRuns: number;
  intervalSec: number;
}) {
  const label = stopping ? "halting" : running ? "active" : "idle";
  const accent = stopping ? "text-warning" : running ? "text-cyan" : "text-text-dim";
  const glow = running && !stopping ? "cyan-glow" : "";
  return (
    <div className="border border-rule bg-bg-soft px-5 py-4 flex items-center gap-6">
      <div className="flex items-baseline gap-3">
        <span className={`font-display text-2xl tracking-widest ${accent} ${glow}`}>
          {label.toUpperCase()}
        </span>
        {running && !stopping && (
          <span className="autorun-pulse h-2 w-2 rounded-full bg-cyan" />
        )}
      </div>
      <div className="flex-1 grid grid-cols-3 gap-4 text-[10px] font-mono text-text-dim">
        <div>
          <div className="text-text-dim/70">CURRENT RUN</div>
          <div className="text-amber-dim">
            {currentRunId ?? "—"}
          </div>
        </div>
        <div>
          <div className="text-text-dim/70">LIFETIME RUNS</div>
          <div className="text-amber">{totalRuns}</div>
        </div>
        <div>
          <div className="text-text-dim/70">INTERVAL</div>
          <div className="text-amber">{intervalSec.toFixed(0)}s</div>
        </div>
      </div>
    </div>
  );
}

function QueueCounts({
  curated,
  generated,
  triggerDepth,
}: {
  curated: number;
  generated: number;
  triggerDepth: number;
}) {
  const total = curated + generated;
  const willTrigger = total < triggerDepth;
  return (
    <div className="grid grid-cols-3 gap-px bg-rule border border-rule">
      <Cell label="curated remaining" value={String(curated)} />
      <Cell label="generated remaining" value={String(generated)} />
      <Cell
        label="proposer trigger"
        value={`< ${triggerDepth}`}
        accent={willTrigger ? "text-amber amber-glow" : "text-text-dim"}
      />
    </div>
  );
}

function Cell({
  label,
  value,
  accent = "text-amber",
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="bg-bg-soft px-4 py-3">
      <div className="text-[9px] text-text-dim font-mono tracking-widest uppercase">
        {label}
      </div>
      <div className={`font-display text-lg ${accent}`}>{value}</div>
    </div>
  );
}

function LiveLog({
  events,
}: {
  events: AutorunStatus["recent_log"];
}) {
  return (
    <Pane title="live log" subtitle="last 20 controller events">
      <ul className="text-[11px] font-mono max-h-80 overflow-y-auto">
        {events.length === 0 && (
          <li className="text-text-dim italic px-3 py-6 text-center">
            — quiet —
          </li>
        )}
        {events.map((e, i) => (
          <li
            key={`${e.ts}-${i}`}
            className="px-3 py-1.5 border-b border-rule/30 last:border-b-0"
          >
            <span className="text-text-dim/60 mr-2">
              {formatRelative(e.ts)}
            </span>
            <KindBadge kind={e.kind} />
            <span className="text-text">{e.message}</span>
          </li>
        ))}
      </ul>
    </Pane>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const map: Record<string, { color: string; label: string }> = {
    started: { color: "text-cyan", label: "▶" },
    stopped: { color: "text-warning", label: "■" },
    "probe-begin": { color: "text-amber", label: ">" },
    "probe-end": { color: "text-amber-dim", label: "✓" },
    "queue-empty": { color: "text-warning", label: "Ø" },
    proposer: { color: "text-cyan-dim", label: "P" },
    error: { color: "text-warning", label: "!" },
  };
  const cfg = map[kind] ?? { color: "text-text-dim", label: "·" };
  return (
    <span className={`inline-block w-4 mr-1 ${cfg.color}`}>{cfg.label}</span>
  );
}

function QueuePreview({
  items,
}: {
  items: AutorunStatus["queue_preview"];
}) {
  return (
    <Pane title="next up" subtitle="upcoming probes (in order)">
      <ul className="text-[11px] font-mono">
        {items.length === 0 && (
          <li className="text-text-dim italic px-3 py-6 text-center">
            queue empty — proposer will fill it
          </li>
        )}
        {items.map((it, i) => (
          <li
            key={i}
            className="px-3 py-2 border-b border-rule/30 last:border-b-0"
          >
            <div className="flex items-baseline gap-2 mb-0.5">
              <span className="text-amber-dim w-5">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="text-text leading-snug flex-1">
                {it.prompt_text}
              </span>
            </div>
            <div className="text-[9px] text-text-dim pl-7">
              {it.source}
              {it.rationale && (
                <span className="text-cyan-dim italic"> · {it.rationale}</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Pane>
  );
}

function ProposerStatus({
  state,
  startedAt,
  finishedAt,
  lastCount,
  lastError,
  batchSize,
}: {
  state: "idle" | "running" | "failed";
  startedAt: number | null;
  finishedAt: number | null;
  lastCount: number;
  lastError: string | null;
  batchSize: number;
}) {
  const pillColor = {
    idle: "text-text-dim",
    running: "text-cyan cyan-glow",
    failed: "text-warning",
  }[state];
  return (
    <Pane title="proposer" subtitle={`Qwen3-14B · target ${batchSize} probes / swap`}>
      <div className="px-4 py-4">
        <div className="flex items-baseline gap-3 mb-3">
          <span className={`font-display text-lg tracking-widest ${pillColor}`}>
            {state.toUpperCase()}
          </span>
          {state === "running" && (
            <span className="autorun-pulse h-1.5 w-1.5 rounded-full bg-cyan" />
          )}
        </div>
        <dl className="text-[10px] font-mono space-y-1.5 text-text-dim">
          <div className="flex justify-between">
            <dt className="text-text-dim/70">last batch</dt>
            <dd className="text-amber">{lastCount} probes</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-dim/70">started</dt>
            <dd>{startedAt ? formatRelative(startedAt) : "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-dim/70">finished</dt>
            <dd>{finishedAt ? formatRelative(finishedAt) : "—"}</dd>
          </div>
        </dl>
        {lastError && (
          <div className="text-warning text-[10px] mt-3 font-mono italic">
            last error: {lastError}
          </div>
        )}
      </div>
    </Pane>
  );
}

function Pane({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-bg-soft flex flex-col">
      <div className="px-4 py-3 border-b border-rule shrink-0">
        <div className="font-display text-xs text-amber tracking-widest">
          {title}
        </div>
        <div className="text-[10px] text-text-dim italic mt-0.5">
          {subtitle}
        </div>
      </div>
      {children}
    </div>
  );
}

function RecentRuns({ rows }: { rows: RecentRow[] }) {
  return (
    <section>
      <header className="border-b border-rule pb-2 mb-4 flex items-baseline justify-between">
        <div>
          <div className="font-display text-xs text-amber tracking-widest">
            recent autorun activity
          </div>
          <div className="text-[10px] text-text-dim italic mt-0.5">
            Probes the loop has driven through the model. Click to revisit
            the verdict.
          </div>
        </div>
        <Link
          href="/archive"
          className="font-mono text-[10px] text-text-dim hover:text-amber-dim"
        >
          full archive →
        </Link>
      </header>
      {rows.length === 0 ? (
        <div className="text-text-dim italic text-xs px-3 py-6 border border-rule bg-bg-soft">
          No autorun activity yet — start the loop and check back.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
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
                      {new Date(r.started_at * 1000).toLocaleString()}
                      {" · "}
                      <span className={
                        r.source === "proposer"
                          ? "text-cyan-dim"
                          : "text-amber-dim"
                      }>
                        {r.source}
                      </span>
                      {" · "}
                      {r.total_tokens} tokens
                      {r.stopped_reason && <> · {r.stopped_reason}</>}
                    </div>
                  </div>
                  <div className="text-text-dim text-[10px] font-mono shrink-0">
                    {r.run_id}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatRelative(ts: number): string {
  const seconds = Math.floor(Date.now() / 1000 - ts);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
