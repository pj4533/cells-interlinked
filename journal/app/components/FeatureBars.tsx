import type { FeatureRow } from "../../lib/reports";

/**
 * Custom-rolled feature chart — definitely no chart-library look.
 *
 * Each row: rank · label · bar · hits · L#·F# (link to Neuronpedia).
 * Bars normalize to the panel's max hits. Color comes from the panel's
 * accent ("amber" or "cyan"); both render on the same dark background.
 */

const NP_MODEL_ID = "deepseek-r1-distill-llama-8b";
const NP_SAE_SUFFIX = "llamascope-slimpj-openr1-res-32k";

const ACCENT = {
  amber: {
    text: "text-amber",
    textDim: "text-amber-dim",
    barFill: "rgba(232,195,130,0.65)",
    barStroke: "rgba(245,212,155,0.95)",
  },
  cyan: {
    text: "text-cyan",
    textDim: "text-cyan-dim",
    barFill: "rgba(94,229,229,0.5)",
    barStroke: "rgba(94,229,229,0.85)",
  },
} as const;

export default function FeatureBars({
  title,
  subtitle,
  accent,
  rows,
}: {
  title: string;
  subtitle: string;
  accent: keyof typeof ACCENT;
  rows: FeatureRow[];
}) {
  const cfg = ACCENT[accent];
  const maxHits = Math.max(1, ...rows.map((r) => r.hits));

  return (
    <div className="bg-bg-soft/60">
      <header className="px-5 py-4 border-b border-rule">
        <div className={`font-display text-xs tracking-widest ${cfg.text}`}>
          {title}
        </div>
        <div className="text-[10px] text-text-dim italic mt-0.5 font-prose">
          {subtitle}
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="text-text-dim italic px-5 py-10 text-center text-xs font-prose">
          — no recurring features in this batch —
        </div>
      ) : (
        <ul className="font-mono text-[11px]">
          {rows.map((r, i) => {
            const pct = Math.min(100, Math.max(2, (r.hits / maxHits) * 100));
            const npHref = `https://www.neuronpedia.org/${NP_MODEL_ID}/${r.layer}-${NP_SAE_SUFFIX}/${r.feature_id}`;
            return (
              <li
                key={`${r.layer}-${r.feature_id}`}
                className="px-5 py-3 border-b border-rule/40 last:border-b-0"
              >
                <div className="flex items-baseline gap-3 mb-2">
                  <span className={`${cfg.textDim} w-6 text-[10px] tabular-nums`}>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-text leading-snug flex-1 font-prose text-[12.5px]">
                    {r.label || (
                      <span className="text-text-deep italic">
                        unlabeled feature
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex items-center gap-3 pl-9">
                  <div
                    className="h-[3px] bg-bg relative overflow-hidden flex-1 border border-rule/40"
                    aria-hidden
                  >
                    <div
                      className="absolute inset-y-0 left-0"
                      style={{
                        width: `${pct}%`,
                        background: cfg.barFill,
                        borderRight: `1px solid ${cfg.barStroke}`,
                        boxShadow: `0 0 8px ${cfg.barStroke}`,
                      }}
                    />
                  </div>
                  <span className="text-[9px] text-text-dim tabular-nums shrink-0">
                    {r.hits} runs
                  </span>
                  <a
                    href={npHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[9px] text-text-dim hover:text-amber-dim shrink-0"
                    title="Open feature on Neuronpedia"
                  >
                    L{r.layer}·{r.feature_id} ↗
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
