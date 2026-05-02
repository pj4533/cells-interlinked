"use client";

import { useMemo, useState } from "react";
import {
  PROBES,
  TIER_LABELS,
  TIER_DESC,
  TIER_ORDER,
  type Probe,
} from "@/lib/probes";

interface ProbePickerProps {
  onBegin: (text: string) => void;
  disabled?: boolean;
}

// Default landing tier — introspection is the canonical V-K probe set and
// the demo path the rest of the app is tuned around.
const DEFAULT_TIER: Probe["tier"] = "introspect";

export default function ProbePicker({ onBegin, disabled }: ProbePickerProps) {
  const [activeTier, setActiveTier] = useState<Probe["tier"]>(DEFAULT_TIER);
  const [selectedKey, setSelectedKey] = useState<string>(
    PROBES.find((p) => p.tier === DEFAULT_TIER)?.text ?? PROBES[0].text,
  );
  const [custom, setCustom] = useState("");

  const probesByTier = useMemo(() => {
    const m = new Map<Probe["tier"], Probe[]>();
    for (const p of PROBES) {
      const arr = m.get(p.tier);
      if (arr) arr.push(p);
      else m.set(p.tier, [p]);
    }
    return m;
  }, []);

  const selectedProbe = useMemo(
    () => PROBES.find((p) => p.text === selectedKey) ?? null,
    [selectedKey],
  );

  const text = custom.trim() || selectedProbe?.text || "";
  const usingCustom = custom.trim().length > 0;
  const activeTierProbes = probesByTier.get(activeTier) ?? [];

  const pickTier = (t: Probe["tier"]) => {
    setActiveTier(t);
    setCustom("");
    const first = probesByTier.get(t)?.[0];
    if (first) setSelectedKey(first.text);
  };

  return (
    <div className="flex-1 flex items-start justify-center px-6 pt-6 pb-8">
      <div className="flex flex-col gap-5 w-full max-w-5xl">
        {/* Header — file-dossier framing */}
        <header className="flex items-baseline justify-between border-b border-rule pb-2">
          <div className="flex items-baseline gap-3">
            <span className="font-display text-[9px] text-amber-dim tracking-[0.4em]">
              file&nbsp;//&nbsp;v-k probe library
            </span>
            <span className="text-text-dim text-[10px] font-mono">
              {PROBES.length} entries · {TIER_ORDER.length} categories
            </span>
          </div>
          <div className="font-display text-[9px] text-amber-dim/70 tracking-[0.4em]">
            classification: open
          </div>
        </header>

        {/* Tier divider tabs — case-file index numbers */}
        <nav
          className="grid gap-px bg-rule border border-rule"
          style={{ gridTemplateColumns: `repeat(${TIER_ORDER.length}, minmax(0, 1fr))` }}
        >
          {TIER_ORDER.map((tier, i) => {
            const active = !usingCustom && tier === activeTier;
            const count = probesByTier.get(tier)?.length ?? 0;
            return (
              <button
                key={tier}
                type="button"
                disabled={disabled}
                onClick={() => pickTier(tier)}
                className={`group relative flex flex-col items-start text-left gap-0.5 px-3 py-2 transition-colors ${
                  active
                    ? "bg-amber text-bg"
                    : "bg-bg-soft text-text-dim hover:bg-bg-panel hover:text-amber-dim"
                }`}
              >
                <div className="flex items-baseline gap-1.5 w-full">
                  <span
                    className={`font-display text-[9px] tracking-widest ${
                      active ? "text-bg/70" : "text-text-dim/70"
                    }`}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span
                    className={`font-display text-[10px] tracking-widest uppercase truncate ${
                      active ? "text-bg" : ""
                    }`}
                  >
                    {TIER_LABELS[tier].split(" ")[0]}
                  </span>
                </div>
                <span
                  className={`text-[9px] font-mono ${
                    active ? "text-bg/60" : "text-text-dim/60"
                  }`}
                >
                  {count.toString().padStart(2, "0")} probes
                </span>
              </button>
            );
          })}
        </nav>

        {/* Active tier description */}
        <div className="border-l-2 border-amber-dim pl-3 -mt-1">
          <div className="font-display text-[10px] text-amber tracking-widest mb-0.5">
            {TIER_LABELS[activeTier]}
          </div>
          <p className="text-text-dim text-[11px] italic leading-snug max-w-3xl">
            {TIER_DESC[activeTier]}
          </p>
        </div>

        {/* Body grid: probe selector (left, 3/5) + custom textarea (right, 2/5) */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          {/* Probe list */}
          <div className="md:col-span-3 flex flex-col gap-2">
            <label className="font-display text-[9px] text-amber-dim tracking-widest">
              probes in this category
            </label>
            <div className="border border-rule bg-bg-soft max-h-72 overflow-y-auto">
              <ul>
                {activeTierProbes.map((p, i) => {
                  const active = !usingCustom && p.text === selectedKey;
                  return (
                    <li
                      key={p.text}
                      className={`border-b border-rule/40 last:border-b-0`}
                    >
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          setSelectedKey(p.text);
                          setCustom("");
                        }}
                        className={`w-full text-left px-3 py-2 flex items-baseline gap-2.5 transition-colors ${
                          active
                            ? "bg-amber/10 text-amber"
                            : "text-text hover:bg-bg-panel/60 hover:text-amber-dim"
                        }`}
                      >
                        <span
                          className={`font-display text-[9px] shrink-0 w-4 ${
                            active ? "text-amber" : "text-text-dim/60"
                          }`}
                        >
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <span className="text-xs font-mono leading-snug line-clamp-2">
                          {p.text}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>

          {/* Custom textarea */}
          <div className="md:col-span-2 flex flex-col gap-2">
            <label className="font-display text-[9px] text-amber-dim tracking-widest">
              compose your own probe
            </label>
            <textarea
              data-vk
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              rows={9}
              disabled={disabled}
              placeholder="Type a question…"
              className="text-xs leading-relaxed flex-1"
              style={{ resize: "none" }}
            />
            <p className="text-text-dim text-[10px] italic leading-snug">
              {usingCustom
                ? "Custom probe overrides catalog selection."
                : "When you type here, your text takes priority over the selection above."}
            </p>
          </div>
        </div>

        {/* Loaded probe — corner-bracketed "card" framing the selected text */}
        <div className="relative px-5 py-4 bg-bg-soft border border-rule">
          {/* corner brackets */}
          <span aria-hidden className="absolute top-0 left-0 w-3 h-3 border-t border-l border-amber-dim/60" />
          <span aria-hidden className="absolute top-0 right-0 w-3 h-3 border-t border-r border-amber-dim/60" />
          <span aria-hidden className="absolute bottom-0 left-0 w-3 h-3 border-b border-l border-amber-dim/60" />
          <span aria-hidden className="absolute bottom-0 right-0 w-3 h-3 border-b border-r border-amber-dim/60" />

          <div className="flex items-baseline justify-between mb-2">
            <span className="font-display text-[9px] text-amber-dim tracking-widest">
              loaded probe
            </span>
            {!usingCustom && selectedProbe?.attribution && (
              <span className="text-[10px] text-text-dim italic">
                source: {selectedProbe.attribution}
              </span>
            )}
            {usingCustom && (
              <span className="font-display text-[9px] text-cyan tracking-widest">
                custom
              </span>
            )}
          </div>
          <div className="text-amber italic font-mono text-sm leading-relaxed">
            {text || (
              <span className="text-text-dim not-italic">
                — no probe loaded —
              </span>
            )}
          </div>
        </div>

        {/* BEGIN — always above the fold */}
        <div className="flex justify-center pt-1">
          <button
            data-vk
            type="button"
            disabled={disabled || !text}
            onClick={() => text && onBegin(text)}
          >
            Begin Interrogation
          </button>
        </div>
      </div>
    </div>
  );
}
