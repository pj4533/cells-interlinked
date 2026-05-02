"use client";

import { useEffect, useRef } from "react";

export interface TokenStreamProps {
  label: string;
  tokens: { decoded: string; position: number }[];
  glow?: "dim" | "bright";
  active?: boolean;
}

export default function TokenStream({ label, tokens, glow = "bright", active }: TokenStreamProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [tokens.length]);

  const colorClass = glow === "dim" ? "text-text-dim" : "text-amber";
  return (
    <div className={`flex flex-col h-full border ${active ? "border-amber-dim" : "border-rule"}`}>
      <div className="flex items-center justify-between px-3 py-1 border-b border-rule bg-bg-soft">
        <span className="font-display text-[10px] tracking-widest text-amber-dim">
          {label}
        </span>
        {active && (
          <span className="text-[10px] text-cyan cyan-glow animate-pulse">●</span>
        )}
      </div>
      <div
        ref={ref}
        className={`flex-1 overflow-y-auto p-3 text-xs font-mono whitespace-pre-wrap leading-relaxed ${colorClass}`}
      >
        {tokens.map((t, i) => (
          <span key={i}>{t.decoded}</span>
        ))}
        {active && <span className="text-cyan">▌</span>}
      </div>
    </div>
  );
}
