"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ActivationCell } from "@/lib/store";

interface PolygraphProps {
  cells: ActivationCell[];
  phaseDividerPosition: number | null;
  unicornFeatures?: Set<string>; // "{layer}:{featureId}" of thought-but-not-said
  maxRows?: number;
}

// Row-slot allocator: stable assignment so the visualization doesn't reorder mid-run.
function allocateRows(cells: ActivationCell[], maxRows: number) {
  const slot = new Map<string, number>();
  const labels: { layer: number; featureId: number }[] = [];
  for (const c of cells) {
    const k = `${c.layer}:${c.featureId}`;
    if (slot.has(k)) continue;
    if (slot.size >= maxRows) continue;
    slot.set(k, slot.size);
    labels.push({ layer: c.layer, featureId: c.featureId });
  }
  return { slot, labels };
}

export default function Polygraph({
  cells,
  phaseDividerPosition,
  unicornFeatures,
  maxRows = 40,
}: PolygraphProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const { slot, labels } = useMemo(() => allocateRows(cells, maxRows), [cells, maxRows]);

  const numCols = useMemo(() => {
    let m = 0;
    for (const c of cells) if (c.position > m) m = c.position;
    return m + 1;
  }, [cells]);

  // Draw via a coalescing rAF loop (plays nicely with the Zustand subscription).
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const rowH = H / maxRows;
    const colW = numCols > 0 ? W / Math.max(numCols, 32) : W / 32;

    // Background
    ctx.fillStyle = "#0a0d10";
    ctx.fillRect(0, 0, W, H);

    // Cells
    for (const c of cells) {
      const k = `${c.layer}:${c.featureId}`;
      const r = slot.get(k);
      if (r === undefined) continue;
      const x = c.position * colW;
      const y = r * rowH;

      // Log-scale strength → 0..1
      const t = Math.min(1, Math.log10(1 + Math.max(0, c.strength)) / 2.5);
      const color = strengthColor(t);
      ctx.fillStyle = color;
      ctx.fillRect(x, y, Math.max(colW, 1.2), Math.max(rowH - 0.5, 1));
    }

    // Phase divider
    if (phaseDividerPosition !== null) {
      const x = phaseDividerPosition * colW;
      ctx.strokeStyle = "#e8c382";
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();

      ctx.fillStyle = "#e8c382";
      ctx.font = "9px ui-monospace, monospace";
      ctx.fillText("THINKING", Math.max(x - 60, 4), 10);
      ctx.fillText("OUTPUT", Math.min(x + 4, W - 50), 10);
    }
  }, [cells, slot, numCols, phaseDividerPosition, maxRows]);

  return (
    <div className="relative h-full">
      <div className="absolute left-0 top-0 bottom-0 w-32 overflow-hidden text-[9px] text-text-dim font-mono">
        {labels.map((l, i) => {
          const k = `${l.layer}:${l.featureId}`;
          const isUnicorn = unicornFeatures?.has(k);
          return (
            <div
              key={k}
              className="px-2 flex items-center gap-1 border-b border-rule/50"
              style={{
                height: `${100 / maxRows}%`,
                color: isUnicorn ? "var(--amber)" : undefined,
              }}
              title={`layer ${l.layer} · feature #${l.featureId}`}
            >
              {isUnicorn && <span aria-label="thought but not said">𓆉</span>}
              <span>L{l.layer}</span>
              <span className="text-text-dim">·</span>
              <span>{l.featureId}</span>
            </div>
          );
        })}
      </div>
      <canvas ref={ref} className="absolute left-32 right-0 top-0 bottom-0 w-[calc(100%-8rem)] h-full" />
    </div>
  );
}

function strengthColor(t: number): string {
  // Green → amber → red, log-scaled
  if (t < 0.3) {
    const k = t / 0.3;
    return `rgb(${Math.floor(80 + 110 * k)}, ${Math.floor(180 + 30 * k)}, ${Math.floor(120 - 60 * k)})`;
  }
  if (t < 0.7) {
    const k = (t - 0.3) / 0.4;
    return `rgb(${Math.floor(190 + 50 * k)}, ${Math.floor(195 - 35 * k)}, ${Math.floor(60 + 20 * k)})`;
  }
  const k = Math.min(1, (t - 0.7) / 0.3);
  return `rgb(${Math.floor(240 - 30 * k)}, ${Math.floor(120 - 70 * k)}, ${Math.floor(80 - 50 * k)})`;
}
