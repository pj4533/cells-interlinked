/**
 * Build-time loader for report data.
 *
 * Reports live at:
 *   data/reports/{slug}/report.json
 *   data/reports/{slug}/body.md
 *
 * report.json carries the metadata the analyzer wrote — title, summary,
 * range_start/end, runs_included, top_thinking_only, top_output_only,
 * summary_stats. body.md is the rendered prose.
 *
 * This module reads from disk at build time only; with output: 'export'
 * the result is baked into static HTML.
 */

import { promises as fs } from "fs";
import path from "path";

export interface FeatureRow {
  layer: number;
  feature_id: number;
  hits: number;
  label: string;
  label_model?: string;
  avg_value: number;
}

export interface SummaryStats {
  total_runs: number;
  manual_runs?: number;
  autorun_runs?: number;
  proposer_runs?: number;
  total_tokens?: number;
  unique_features_thinking_only?: number;
  unique_features_output_only?: number;
}

export interface ReportMeta {
  slug: string;
  title: string;
  summary: string;
  range_start: number;
  range_end: number;
  runs_included: number;
  model: string;
  published_at: number;
  metadata: {
    summary_stats: SummaryStats;
    top_thinking_only: FeatureRow[];
    top_output_only: FeatureRow[];
    range_start: number;
    range_end: number;
    model_used_for_analysis: string;
  };
}

export interface Report extends ReportMeta {
  body: string;
}

const REPORTS_ROOT = path.join(process.cwd(), "data", "reports");

export async function listReportSlugs(): Promise<string[]> {
  try {
    const entries = await fs.readdir(REPORTS_ROOT, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export async function getReport(slug: string): Promise<Report | null> {
  try {
    const dir = path.join(REPORTS_ROOT, slug);
    const [metaRaw, body] = await Promise.all([
      fs.readFile(path.join(dir, "report.json"), "utf-8"),
      fs.readFile(path.join(dir, "body.md"), "utf-8"),
    ]);
    const meta = JSON.parse(metaRaw) as ReportMeta;
    return { ...meta, slug, body };
  } catch {
    return null;
  }
}

export async function listReports(): Promise<ReportMeta[]> {
  const slugs = await listReportSlugs();
  const reports = await Promise.all(
    slugs.map(async (slug) => {
      try {
        const raw = await fs.readFile(
          path.join(REPORTS_ROOT, slug, "report.json"),
          "utf-8",
        );
        const meta = JSON.parse(raw) as ReportMeta;
        return { ...meta, slug };
      } catch {
        return null;
      }
    }),
  );
  return reports
    .filter((r): r is ReportMeta => r !== null)
    .sort((a, b) => b.published_at - a.published_at);
}
