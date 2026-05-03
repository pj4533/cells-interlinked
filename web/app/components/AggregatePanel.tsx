"use client";

import { useMemo } from "react";
import ExplainerBadge from "./ExplainerBadge";

/** A single row in the cross-run aggregate view. Mirrors the per-run
 *  FeaturePanel shape but adds `hits` (number of distinct runs the
 *  feature appeared in this phase-exclusive list) and `total_runs`
 *  (denominator for the fraction display). */
export interface AggregateRow {
  layer: number;
  feature_id: number;
  hits: number;
  total_runs: number;
  /** Mean delta across the runs where this feature appeared. Used as
   *  the secondary sort key on the backend and shown next to the bar. */
  avg_value: number;
  label: string;
  label_model: string;
}

const NP_MODEL_ID = "deepseek-r1-distill-llama-8b";
const NP_SAE_SUFFIX = "llamascope-slimpj-openr1-res-32k";

/** Cross-run aggregate panel. Visual language matches FeaturePanel on
 *  the verdict page: same column header, same row layout, same hover,
 *  same Neuronpedia link. The metadata strip differs — instead of a
 *  raw activation value, we show "X / Y runs · avg N.NN" so the
 *  hits-vs-strength tradeoff is visible at a glance. The bar normalizes
 *  to the highest hit-count in the panel (so the most-recurring feature
 *  reads as a full bar). */
export default function AggregatePanel({
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
  rows: AggregateRow[];
}) {
  const maxHits = useMemo(
    () => Math.max(1, ...rows.map((r) => r.hits)),
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
      <ul className="p-1.5 max-h-[28rem] overflow-y-auto text-xs font-mono">
        {rows.length === 0 && (
          <li className="text-text-dim italic px-3 py-6 text-center">
            — not enough runs yet —
          </li>
        )}
        {rows.map((r, i) => {
          const pct = Math.min(100, Math.max(2, (r.hits / maxHits) * 100));
          const npHref = `https://www.neuronpedia.org/${NP_MODEL_ID}/${r.layer}-${NP_SAE_SUFFIX}/${r.feature_id}`;
          return (
            <li
              key={`${r.layer}-${r.feature_id}`}
              className="px-3 py-2 border-b border-rule/30 last:border-b-0 hover:bg-bg-panel/60 transition-colors"
              title={`Layer ${r.layer} · feature #${r.feature_id} · ${r.hits} of ${r.total_runs} runs · avg ${r.avg_value.toFixed(3)}`}
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
                <span className="text-[9px] text-text-dim font-mono shrink-0 tabular-nums">
                  {r.hits}/{r.total_runs} · avg {r.avg_value.toFixed(2)}
                </span>
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
