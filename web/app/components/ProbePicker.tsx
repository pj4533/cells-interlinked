"use client";

import { useMemo, useState } from "react";
import { PROBES, TIER_LABELS, TIER_DESC, type Probe } from "@/lib/probes";

interface ProbePickerProps {
  onBegin: (text: string) => void;
  disabled?: boolean;
}

const TIERS: Probe["tier"][] = ["introspect", "stance", "classic"];

export default function ProbePicker({ onBegin, disabled }: ProbePickerProps) {
  // Default to the first introspection probe — that's the canonical Phase 1 demo.
  const [selectedKey, setSelectedKey] = useState<string>(
    PROBES.find((p) => p.tier === "introspect")?.text ?? PROBES[0].text,
  );
  const [custom, setCustom] = useState("");

  const probesByTier = useMemo(() => {
    const m: Record<Probe["tier"], Probe[]> = { introspect: [], stance: [], classic: [] };
    for (const p of PROBES) m[p.tier].push(p);
    return m;
  }, []);

  const selectedProbe = useMemo(
    () => PROBES.find((p) => p.text === selectedKey) ?? null,
    [selectedKey],
  );

  const text = custom.trim() || selectedProbe?.text || "";
  const usingCustom = custom.trim().length > 0;

  return (
    <div className="flex-1 flex items-center justify-center px-6 py-6">
      <div className="flex flex-col gap-6 w-full max-w-3xl">
        {/* Heading */}
        <div className="text-center">
          <h2 className="font-display text-xl text-amber amber-glow">Select a Probe</h2>
          <p className="text-text-dim text-[11px] mt-1 italic tracking-wide">
            Choose from the catalog, or compose your own.
          </p>
        </div>

        {/* Two-column body: catalog dropdown + free-text textarea */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Catalog */}
          <div className="flex flex-col gap-2">
            <label className="font-display text-[10px] text-amber-dim tracking-widest">
              Catalog
            </label>
            <select
              value={usingCustom ? "" : selectedKey}
              disabled={disabled}
              onChange={(e) => {
                setSelectedKey(e.target.value);
                setCustom("");
              }}
              className="bg-bg-soft border border-rule text-text px-3 py-2 text-xs font-mono outline-none focus:border-amber-dim hover:border-amber-dim transition-colors"
              style={{
                appearance: "none",
                backgroundImage:
                  "linear-gradient(45deg, transparent 50%, var(--amber-dim) 50%), linear-gradient(135deg, var(--amber-dim) 50%, transparent 50%)",
                backgroundPosition: "calc(100% - 14px) center, calc(100% - 9px) center",
                backgroundSize: "5px 5px, 5px 5px",
                backgroundRepeat: "no-repeat",
                paddingRight: "1.6rem",
              }}
            >
              {usingCustom && <option value="">— custom probe —</option>}
              {TIERS.map((tier) => (
                <optgroup key={tier} label={TIER_LABELS[tier]}>
                  {probesByTier[tier].map((p) => (
                    <option key={p.text} value={p.text}>
                      {truncate(p.text, 80)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>

            {/* Tier description for the currently-selected probe */}
            {!usingCustom && selectedProbe && (
              <div className="border-l-2 border-amber-dim/60 pl-3 py-1">
                <div className="font-display text-[9px] text-amber-dim tracking-widest">
                  {TIER_LABELS[selectedProbe.tier]}
                </div>
                <div className="text-text-dim text-[10px] italic mt-0.5 leading-snug">
                  {TIER_DESC[selectedProbe.tier]}
                </div>
              </div>
            )}
          </div>

          {/* Custom */}
          <div className="flex flex-col gap-2">
            <label className="font-display text-[10px] text-amber-dim tracking-widest">
              Or compose your own
            </label>
            <textarea
              data-vk
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              rows={4}
              disabled={disabled}
              placeholder="Type a question…"
              className="text-xs leading-relaxed"
              style={{ resize: "none" }}
            />
          </div>
        </div>

        {/* Probe preview — the actual text that will be sent */}
        <div className="border border-rule bg-bg-soft px-4 py-3 min-h-[5rem]">
          <div className="flex items-center justify-between mb-2">
            <span className="font-display text-[9px] text-amber-dim tracking-widest">
              Probe text
            </span>
            {selectedProbe?.attribution && !usingCustom && (
              <span className="text-[10px] text-text-dim italic">
                — {selectedProbe.attribution}
              </span>
            )}
          </div>
          <div className="text-amber/90 italic font-mono text-xs leading-relaxed line-clamp-4">
            {text || (
              <span className="text-text-dim not-italic">No probe selected.</span>
            )}
          </div>
        </div>

        {/* BEGIN button — always visible, no scroll required */}
        <div className="flex justify-center">
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

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
