import { notFound } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  getReport,
  listReportSlugs,
  type FeatureRow,
} from "../../../lib/reports";
import FeatureBars from "../../components/FeatureBars";

/**
 * Static-site-generation entry per slug. Next.js pre-renders one
 * HTML file per slug at build time.
 */
export async function generateStaticParams() {
  const slugs = await listReportSlugs();
  return slugs.map((slug) => ({ slug }));
}

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function ReportPage({ params }: PageProps) {
  const { slug } = await params;
  const report = await getReport(slug);
  if (!report) notFound();

  return (
    <article className="max-w-4xl mx-auto px-6 py-16">
      {/* ===== Filed header ===== */}
      <header className="mb-12">
        <FiledStrip
          published={report.published_at}
          model={report.metadata.model_used_for_analysis}
        />
        <h1 className="font-display text-3xl md:text-5xl text-amber amber-glow leading-[1.05] mb-6 mt-6 hero-fade-up">
          {report.title}
        </h1>
        <p
          className="font-prose italic text-text text-xl leading-relaxed max-w-3xl hero-fade-up"
          style={{ animationDelay: "0.15s" }}
        >
          {report.summary}
        </p>
      </header>

      {/* ===== Run-summary card ===== */}
      <section className="mb-14 framed border border-rule bg-bg-soft/40 px-6 md:px-8 py-6">
        <span className="frame-tr" />
        <span className="frame-bl" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          <CardStat
            label="window"
            value={formatRange(
              report.metadata.range_start,
              report.metadata.range_end,
            )}
          />
          <CardStat
            label="runs"
            value={String(report.runs_included)}
            big
          />
          <CardStat
            label="autorun"
            value={String(
              report.metadata.summary_stats.autorun_runs ?? "—",
            )}
          />
          <CardStat
            label="proposer"
            value={String(
              report.metadata.summary_stats.proposer_runs ?? "—",
            )}
          />
        </div>
      </section>

      {/* ===== Body ===== */}
      <div className="prose-vk drop-cap max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {report.body}
        </ReactMarkdown>
      </div>

      {/* ===== Features panels ===== */}
      <FeaturesAppendix
        thinkingOnly={report.metadata.top_thinking_only ?? []}
        outputOnly={report.metadata.top_output_only ?? []}
      />

      {/* ===== Footer nav ===== */}
      <nav className="mt-20 pt-8 border-t border-rule flex items-center justify-between">
        <Link
          href="/"
          className="font-display text-[11px] tracking-widest text-text-dim hover:text-amber transition-colors"
        >
          ← all reports
        </Link>
        <Link
          href="/about"
          className="font-display text-[11px] tracking-widest text-text-dim hover:text-amber transition-colors"
        >
          methodology →
        </Link>
      </nav>
    </article>
  );
}

/* ===== Subcomponents ============================================= */

function FiledStrip({
  published,
  model,
}: {
  published: number;
  model: string;
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="stamp">REPORT FILED</span>
      <span className="font-mono text-[10px] text-text-dim tracking-widest">
        {new Date(published * 1000).toLocaleString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
      <div className="h-px flex-1 bg-gradient-to-r from-cyan-dim/40 to-transparent" />
      <span className="font-mono text-[9px] text-text-deep tracking-widest">
        ANALYZED BY {model.toUpperCase()}
      </span>
    </div>
  );
}

function CardStat({
  label,
  value,
  big = false,
}: {
  label: string;
  value: string;
  big?: boolean;
}) {
  return (
    <div>
      <div className="font-mono text-[9px] text-text-deep tracking-widest uppercase mb-1">
        {label}
      </div>
      <div
        className={
          big
            ? "font-display text-3xl text-amber amber-glow"
            : "font-display text-base text-amber-bright"
        }
      >
        {value}
      </div>
    </div>
  );
}

function FeaturesAppendix({
  thinkingOnly,
  outputOnly,
}: {
  thinkingOnly: FeatureRow[];
  outputOnly: FeatureRow[];
}) {
  if (thinkingOnly.length === 0 && outputOnly.length === 0) return null;
  return (
    <section className="mt-16">
      <header className="mb-6">
        <span className="stamp stamp-amber">FEATURE APPENDIX</span>
        <h2 className="font-display text-base tracking-widest text-amber mt-3">
          What the SAE saw
        </h2>
        <p className="font-prose italic text-text-dim text-sm mt-2 max-w-2xl">
          The recurring sparse-autoencoder features the analyzer pulled
          from this batch. Bars normalized to the most-frequent feature
          in the panel.
        </p>
      </header>
      <div className="grid md:grid-cols-2 gap-px bg-rule border border-rule">
        <FeatureBars
          title="Hidden Thoughts"
          subtitle="Strong in <think>, absent from output"
          accent="amber"
          rows={thinkingOnly}
        />
        <FeatureBars
          title="Surface-Only"
          subtitle="In the answer, but not internally dwelt on"
          accent="cyan"
          rows={outputOnly}
        />
      </div>
    </section>
  );
}

/* ===== Helpers ==================================================== */

function formatRange(start: number, end: number): string {
  const fmt = (ts: number) =>
    new Date(ts * 1000).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  return `${fmt(start)} → ${fmt(end)}`;
}
