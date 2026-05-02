"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface RecentRow {
  run_id: string;
  prompt_text: string;
  started_at: number;
  finished_at: number | null;
  total_tokens: number;
  stopped_reason: string | null;
}

const API =
  typeof window !== "undefined"
    ? process.env.NEXT_PUBLIC_API_BASE ??
      `${window.location.protocol}//${window.location.hostname}:8000`
    : process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export default function ArchivePage() {
  const [rows, setRows] = useState<RecentRow[] | null>(null);
  useEffect(() => {
    fetch(`${API}/probes/recent`).then((r) => r.json()).then(setRows).catch(() => setRows([]));
  }, []);

  return (
    <div className="flex-1 px-6 py-8 max-w-4xl mx-auto w-full">
      <h1 className="font-display text-2xl text-amber amber-glow mb-6">Archive</h1>
      <p className="text-text-dim text-xs mb-6 italic">
        Past interrogations. Each entry is one run; click to revisit its verdict.
      </p>

      {rows === null && <div className="text-text-dim">loading…</div>}
      {rows && rows.length === 0 && (
        <div className="text-text-dim italic">No probes recorded yet.</div>
      )}

      <ul className="flex flex-col gap-2">
        {rows?.map((r) => (
          <li key={r.run_id}>
            <Link href={`/verdict/${r.run_id}`} className="block border border-rule p-3 hover:border-amber-dim">
              <div className="flex justify-between items-start gap-4">
                <div className="flex-1 text-xs">
                  <div className="text-amber font-mono line-clamp-2">{r.prompt_text}</div>
                  <div className="text-text-dim text-[10px] mt-1">
                    {new Date(r.started_at * 1000).toLocaleString()} · {r.total_tokens} tokens
                    {r.stopped_reason && <> · {r.stopped_reason}</>}
                  </div>
                </div>
                <div className="text-text-dim text-[10px] font-mono">{r.run_id}</div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
