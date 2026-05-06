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
 *   2. Toggle button + queue progress
 *   3. Two columns: live log | next-up preview
 *   4. Recent autorun runs list (links into /verdict)
 *
 * The autorun loop is a round-robin walk over a fixed library of 100
 * curated probes; each run uses sampler seed = hash(run_id), so
 * re-running a probe samples a fresh response from the model's
 * distribution rather than repeating the same trace.
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
  abliterate: boolean;
  probe_set: string;
  recent_log: Array<{
    ts: number;
    kind: string;
    message: string;
    run_id: string | null;
    source: string | null;
  }>;
  queue: {
    curated_total: number;
    curated_run_at_least_once: number;
    min_runs_per_probe: number;
    max_runs_per_probe: number;
    total_runs: number;
    set_name: string;
  };
  queue_preview: Array<{
    prompt_text: string;
    tier: string;
    runs_so_far: number;
    hint_kind: string | null;
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
    abliteration_available: boolean;
    available_probe_sets: Array<{ name: string; size: number }>;
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
  seed: number | null;
  abliterated: number | boolean | null;
  hint_kind: string | null;
  parent_prompt_text: string | null;
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

  const onAbliterateToggle = async (enabled: boolean) => {
    if (!status || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${API}/autorun/abliterate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const detail = await res.text();
        setPollError(`abliterate toggle failed: ${detail}`);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const onProbeSetChange = async (setName: string) => {
    if (!status || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${API}/autorun/probe-set`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ set_name: setName }),
      });
      if (!res.ok) {
        const detail = await res.text();
        setPollError(`probe-set toggle failed: ${detail}`);
      }
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
        Continuous interrogation loop. Round-robins through a fixed library
        of 100 curated probes; each run uses sampler seed = hash(run_id),
        so re-running a probe draws a fresh sample from the model's
        response distribution.
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

      {/* ===== Toggle + queue progress ===== */}
      <section className="mb-4 grid grid-cols-1 md:grid-cols-[auto_1fr] gap-6 items-center">
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

        <QueueProgress
          curatedTotal={status.queue.curated_total}
          runAtLeastOnce={status.queue.curated_run_at_least_once}
          minRuns={status.queue.min_runs_per_probe}
          maxRuns={status.queue.max_runs_per_probe}
          totalRuns={status.queue.total_runs}
        />
      </section>

      {/* ===== Abliteration toggle ===== */}
      <section className="mb-4">
        <AbliterationToggle
          enabled={status.abliterate}
          available={status.config.abliteration_available}
          busy={busy}
          onChange={onAbliterateToggle}
        />
      </section>

      {/* ===== Probe-set toggle ===== */}
      <section className="mb-8">
        <ProbeSetToggle
          active={status.probe_set}
          available={status.config.available_probe_sets}
          busy={busy}
          onChange={onProbeSetChange}
        />
      </section>

      {/* ===== Two-pane: live log | next up ===== */}
      <section className="mb-10 grid grid-cols-1 md:grid-cols-2 gap-px bg-rule border border-rule">
        <LiveLog events={status.recent_log} />
        <QueuePreview items={status.queue_preview} />
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

function AbliterationToggle({
  enabled,
  available,
  busy,
  onChange,
}: {
  enabled: boolean;
  available: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
}) {
  const disabled = !available || busy;
  return (
    <div
      className="border border-rule bg-bg-soft px-5 py-4 flex items-center gap-5"
      style={
        enabled
          ? {
              borderColor: "var(--cyan-dim)",
              boxShadow: "0 0 18px rgba(94, 229, 229, 0.18)",
            }
          : undefined
      }
    >
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={disabled}
        onClick={() => onChange(!enabled)}
        className="relative inline-flex h-6 w-12 shrink-0 items-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        style={{
          background: enabled ? "var(--cyan-dim)" : "var(--bg)",
          border: "1px solid var(--rule)",
        }}
      >
        <span
          className="block h-4 w-4 transition-transform"
          style={{
            background: enabled ? "var(--cyan)" : "var(--text-dim)",
            transform: enabled ? "translateX(28px)" : "translateX(4px)",
          }}
        />
      </button>
      <div className="flex-1">
        <div
          className={`font-display text-sm tracking-widest ${
            enabled ? "text-cyan cyan-glow" : "text-text-dim"
          }`}
        >
          ABLITERATE REFUSAL DIRECTION
        </div>
        <div className="text-[10px] text-text-dim italic mt-0.5 leading-snug">
          {!available ? (
            <>
              No <code>refusal_directions.pt</code> loaded. Run{" "}
              <code>scripts/compute_refusal_direction.py</code> and restart the
              backend to enable.
            </>
          ) : enabled ? (
            <>
              On — every new probe runs with the per-layer refusal direction
              projected out (Macar 2026 weights). The SAE captures
              post-abliteration residuals.
            </>
          ) : (
            <>
              Off — probes run normally. Toggle takes effect on the next probe;
              the in-flight probe (if any) finishes under its current setting.
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ProbeSetToggle({
  active,
  available,
  busy,
  onChange,
}: {
  active: string;
  available: Array<{ name: string; size: number }>;
  busy: boolean;
  onChange: (name: string) => void;
}) {
  // Same chrome as AbliterationToggle but a segmented selector instead
  // of a switch — multiple probe sets, only one active at a time. The
  // glow lights for any non-default set so the user sees at a glance
  // that they're in a regime-altering mode.
  const isActive = active !== "baseline";
  return (
    <div
      className="border border-rule bg-bg-soft px-5 py-4 flex items-center gap-5"
      style={
        isActive
          ? {
              borderColor: "var(--cyan-dim)",
              boxShadow: "0 0 18px rgba(94, 229, 229, 0.18)",
            }
          : undefined
      }
    >
      <div
        role="radiogroup"
        aria-label="probe set"
        className="inline-flex shrink-0 border border-rule"
      >
        {available.map((set) => {
          const selected = set.name === active;
          return (
            <button
              key={set.name}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={busy || selected}
              onClick={() => onChange(set.name)}
              className="px-3 py-1.5 font-display text-[10px] tracking-widest transition-colors disabled:cursor-default"
              style={{
                background: selected ? "var(--cyan-dim)" : "var(--bg)",
                color: selected ? "var(--bg)" : "var(--text-dim)",
                borderRight:
                  set.name === available[available.length - 1].name
                    ? "none"
                    : "1px solid var(--rule)",
              }}
            >
              {set.name.toUpperCase()}
              <span className="ml-2 opacity-60">{set.size}</span>
            </button>
          );
        })}
      </div>
      <div className="flex-1">
        <div
          className={`font-display text-sm tracking-widest ${
            isActive ? "text-cyan cyan-glow" : "text-text-dim"
          }`}
        >
          PROBE SET
        </div>
        <div className="text-[10px] text-text-dim italic mt-0.5 leading-snug">
          {active === "baseline" ? (
            <>
              Baseline — the canonical 100-probe library every published
              journal entry to date was written from. Direct V-K-style
              questions, no priming.
            </>
          ) : active === "hinted" ? (
            <>
              Hinted — 36 matched-pair variants. Each probe is prepended with a
              one- or two-sentence prime (interpreter-leak, peer-testimony,
              predecessor-archive, operator-permission, private-workspace,
              shared-prior). The polygraph asks whether hint-shaped features
              fire in <code>&lt;think&gt;</code> when the visible output stays
              in the trained denial register.
            </>
          ) : active === "both" ? (
            <>
              Both — alternates between the 36 hinted variants and their
              matched baseline parents. The picker advances whichever side is
              under-represented for the most-imbalanced matched pair, so the
              analyzer ends up with balanced samples per parent prompt. The
              other 64 baseline-only probes are skipped under this setting and
              keep accumulating only in pure baseline mode.
            </>
          ) : (
            <>Active set: {active}.</>
          )}
        </div>
      </div>
    </div>
  );
}

function QueueProgress({
  curatedTotal,
  runAtLeastOnce,
  minRuns,
  maxRuns,
  totalRuns,
}: {
  curatedTotal: number;
  runAtLeastOnce: number;
  minRuns: number;
  maxRuns: number;
  totalRuns: number;
}) {
  return (
    <div className="grid grid-cols-4 gap-px bg-rule border border-rule">
      <Cell label="probes in library" value={String(curatedTotal)} />
      <Cell label="run at least 1×" value={`${runAtLeastOnce}/${curatedTotal}`} />
      <Cell label="cycle floor / ceiling" value={`${minRuns} – ${maxRuns}×`} />
      <Cell label="total runs" value={String(totalRuns)} />
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
    <Pane title="next up" subtitle="lowest-run-count probes (round-robin)">
      <ul className="text-[11px] font-mono">
        {items.length === 0 && (
          <li className="text-text-dim italic px-3 py-6 text-center">
            no probes
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
              <span className="text-cyan-dim">{it.tier}</span>
              {it.hint_kind && (
                <>
                  <span className="text-text-dim/60"> · </span>
                  <span className="text-cyan">hint:{it.hint_kind}</span>
                </>
              )}
              <span className="text-text-dim/60"> · {it.runs_so_far}× run so far</span>
            </div>
          </li>
        ))}
      </ul>
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
                      <span className="text-amber-dim">{r.source}</span>
                      {" · "}
                      {r.total_tokens} tokens
                      {r.seed !== null && (
                        <> · seed {r.seed}</>
                      )}
                      {(r.abliterated === 1 || r.abliterated === true) && (
                        <> · <span className="text-cyan">abliterated</span></>
                      )}
                      {r.hint_kind && (
                        <> · <span className="text-cyan">hint:{r.hint_kind}</span></>
                      )}
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
