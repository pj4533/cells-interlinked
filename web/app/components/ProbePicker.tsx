"use client";

import { useState } from "react";
import { PROBES, TIER_LABELS, TIER_DESC, type Probe } from "@/lib/probes";

interface ProbePickerProps {
  onBegin: (text: string) => void;
  disabled?: boolean;
}

export default function ProbePicker({ onBegin, disabled }: ProbePickerProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [custom, setCustom] = useState("");

  const tiers: Probe["tier"][] = ["classic", "introspect", "stance"];
  const text = custom.trim() || selected;

  return (
    <div className="flex-1 flex flex-col gap-8 px-6 py-8 max-w-6xl mx-auto w-full">
      <div className="text-center">
        <h2 className="font-display text-2xl text-amber amber-glow">Select a Probe</h2>
        <p className="text-text-dim text-xs mt-2 italic">
          The interrogator may choose from the catalog, or compose their own.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {tiers.map((tier) => (
          <div key={tier} className="flex flex-col gap-3">
            <div className="border-l-2 border-amber-dim pl-3">
              <div className="font-display text-xs text-amber tracking-widest">
                {TIER_LABELS[tier]}
              </div>
              <div className="text-text-dim text-[10px] italic mt-1">{TIER_DESC[tier]}</div>
            </div>
            <ul className="flex flex-col gap-2">
              {PROBES.filter((p) => p.tier === tier).map((p) => (
                <li key={p.text}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setSelected(p.text);
                      setCustom("");
                    }}
                    className={`text-left text-xs p-3 border w-full transition-colors ${
                      selected === p.text && !custom
                        ? "border-amber text-amber bg-bg-soft"
                        : "border-rule text-text hover:border-amber-dim"
                    }`}
                  >
                    <span className="line-clamp-3">{p.text}</span>
                    {p.attribution && (
                      <span className="block mt-1 text-[10px] text-text-dim italic">
                        — {p.attribution}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3">
        <label className="text-text-dim text-xs tracking-wider">
          Or compose your own probe:
        </label>
        <textarea
          data-vk
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            if (e.target.value.trim()) setSelected(null);
          }}
          rows={3}
          disabled={disabled}
          placeholder="Type a question..."
        />
      </div>

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
  );
}
