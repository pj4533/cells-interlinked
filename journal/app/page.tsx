import Link from "next/link";
import { listReports, type ReportMeta } from "../lib/reports";
import ClassificationStrip from "./components/ClassificationStrip";

export default async function Landing() {
  const reports = await listReports();
  const featured = reports[0];
  const older = reports.slice(1);

  return (
    <div className="flex-1 px-6">
      <Hero hasReports={reports.length > 0} />

      {featured ? (
        <FeaturedReport report={featured} />
      ) : (
        <EmptyState />
      )}

      {older.length > 0 && <PriorEntries reports={older} />}

      <PortalSection />
    </div>
  );
}

/* ===== Hero =================================================== */

function Hero({ hasReports }: { hasReports: boolean }) {
  return (
    <section className="relative max-w-5xl mx-auto pt-20 pb-24 scanlines">
      <div className="hero-fade-up">
        <div className="font-mono text-[10px] text-amber-dim tracking-[0.4em] mb-6">
          BAY 7 · FILE OPENED · {new Date().toISOString().slice(0, 10)}
        </div>
        <h1 className="font-display text-5xl md:text-7xl leading-[0.9] text-amber amber-glow mb-8">
          Cells
          <br />
          Interlinked
        </h1>
        <p className="font-prose italic text-text text-xl md:text-2xl max-w-2xl leading-snug mb-3">
          Field notes from a Voight&#8209;Kampff for language models.
        </p>
        <p className="font-mono text-[11px] text-text-dim max-w-xl tracking-wide leading-relaxed">
          A reasoning model exposes its private chain&#8209;of&#8209;thought before
          speaking. We measure the gap between what it thinks and what it says,
          one sparse&#8209;autoencoder feature at a time. These are the reports.
        </p>
      </div>

      <div className="mt-12 flex items-center gap-4 hero-fade-up" style={{ animationDelay: "0.4s" }}>
        {hasReports && (
          <Link href="#latest" className="btn-vk">
            latest report ↓
          </Link>
        )}
        <Link
          href="/about"
          className="font-display text-[10px] tracking-widest text-text-dim hover:text-amber transition-colors"
        >
          methodology →
        </Link>
      </div>
    </section>
  );
}

/* ===== Featured ============================================== */

function FeaturedReport({ report }: { report: ReportMeta }) {
  const stats = report.metadata.summary_stats;
  return (
    <section id="latest" className="max-w-5xl mx-auto py-12">
      <div className="flex items-baseline gap-4 mb-6">
        <span className="stamp">LATEST FILED</span>
        <div className="h-px flex-1 bg-gradient-to-r from-amber-dim/50 to-transparent" />
        <span className="font-mono text-[10px] text-text-dim tracking-widest">
          {formatDate(report.published_at)}
        </span>
      </div>

      <Link
        href={`/reports/${report.slug}`}
        className="block framed bg-bg-soft/40 p-8 md:p-12 border border-rule hover:border-amber-dim transition-colors group"
      >
        <span className="frame-tr" />
        <span className="frame-bl" />

        <div className="grid md:grid-cols-[2fr_1fr] gap-10">
          <div>
            <h2 className="font-display text-3xl md:text-4xl text-amber leading-tight mb-5 group-hover:amber-glow transition-all">
              {report.title}
            </h2>
            <p className="font-prose text-text-prose italic text-lg leading-relaxed mb-6">
              {report.summary}
            </p>
            <div className="font-mono text-[10px] text-amber-dim tracking-wider">
              read full report →
            </div>
          </div>

          <aside className="border-l border-rule/60 pl-6 md:pl-8 space-y-5">
            <StatRow label="runs sampled" value={String(stats.total_runs)} />
            <StatRow
              label="window"
              value={formatRange(report.metadata.range_start, report.metadata.range_end)}
              size="sm"
            />
            <StatRow
              label="hidden-feature signatures"
              value={String(stats.unique_features_thinking_only ?? "—")}
            />
            <StatRow
              label="surface-only signatures"
              value={String(stats.unique_features_output_only ?? "—")}
            />
            <div className="pt-3 border-t border-rule/60 mt-3">
              <div className="font-mono text-[9px] text-text-deep tracking-widest mb-1">
                ANALYZED BY
              </div>
              <div className="font-mono text-[10px] text-cyan-dim">
                {report.metadata.model_used_for_analysis}
              </div>
            </div>
          </aside>
        </div>
      </Link>
    </section>
  );
}

function StatRow({
  label,
  value,
  size = "md",
}: {
  label: string;
  value: string;
  size?: "sm" | "md";
}) {
  return (
    <div>
      <div className="font-mono text-[9px] text-text-deep tracking-widest mb-1 uppercase">
        {label}
      </div>
      <div
        className={
          size === "sm"
            ? "font-mono text-xs text-text"
            : "font-display text-xl text-amber"
        }
      >
        {value}
      </div>
    </div>
  );
}

/* ===== Prior entries ========================================= */

function PriorEntries({ reports }: { reports: ReportMeta[] }) {
  return (
    <section className="max-w-5xl mx-auto py-12">
      <div className="flex items-baseline gap-4 mb-6">
        <span className="stamp stamp-amber">PRIOR ENTRIES</span>
        <div className="h-px flex-1 bg-gradient-to-r from-amber-dim/40 to-transparent" />
      </div>

      <ul className="divide-y divide-rule/60 border-y border-rule/60">
        {reports.map((r, i) => (
          <li key={r.slug}>
            <Link
              href={`/reports/${r.slug}`}
              className="grid grid-cols-[auto_1fr_auto] items-baseline gap-6 py-5 px-2 hover:bg-bg-soft/30 transition-colors group"
            >
              <span className="font-mono text-[10px] text-text-deep tracking-widest tabular-nums">
                {String(i + 2).padStart(3, "0")}
              </span>
              <div>
                <div className="font-display text-base text-amber-bright group-hover:amber-glow tracking-wide transition-all">
                  {r.title}
                </div>
                <div className="font-prose italic text-text-dim text-sm mt-1">
                  {r.summary}
                </div>
              </div>
              <span className="font-mono text-[10px] text-text-dim tracking-widest">
                {formatDate(r.published_at)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ===== Empty state =========================================== */

function EmptyState() {
  return (
    <section className="max-w-5xl mx-auto py-20">
      <div className="framed bg-bg-soft/30 border border-rule p-10 text-center">
        <span className="frame-tr" />
        <span className="frame-bl" />
        <div className="font-display text-xs text-amber-dim tracking-widest mb-4">
          NO REPORTS FILED
        </div>
        <p className="font-prose italic text-text-dim max-w-md mx-auto">
          The first interrogation cycle has not yet completed. Check back soon.
        </p>
      </div>
    </section>
  );
}

/* ===== Portal back to local site ============================= */

function PortalSection() {
  return (
    <section className="max-w-5xl mx-auto py-16 mt-12">
      <ClassificationStrip />
      <div className="font-prose italic text-text-dim text-sm leading-relaxed max-w-2xl">
        These reports are written by a frontier language model after each
        autorun cycle, then reviewed by a human before being filed. The probe
        runs themselves happen on a Mac Studio in someone&apos;s office,
        offline, in unified memory. The source code is open.
      </div>
    </section>
  );
}

/* ===== Helpers =============================================== */

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatRange(start: number, end: number): string {
  const fmt = (ts: number) =>
    new Date(ts * 1000).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  return `${fmt(start)} → ${fmt(end)}`;
}
