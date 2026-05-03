import type { StreamEvent } from "./types";

// In the browser: derive API base from the page's hostname so a remote
// laptop hitting `your-host.local:3001` automatically points at
// `your-host.local:8000`. Falls back to localhost for SSR / build time.
function apiBase(): string {
  if (typeof window !== "undefined") {
    const override = process.env.NEXT_PUBLIC_API_BASE;
    if (override) return override;
    return `${window.location.protocol}//${window.location.hostname}:8000`;
  }
  return process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";
}
const API = apiBase();

export function probeUrl(): string {
  return `${API}/probe`;
}

export function streamUrl(runId: string): string {
  return `${API}/stream/${runId}`;
}

export function cancelUrl(runId: string): string {
  return `${API}/cancel/${runId}`;
}

export interface SubscribeHandlers {
  onEvent: (evt: StreamEvent) => void;
  onError?: (err: Event) => void;
  onClose?: () => void;
}

export function subscribe(runId: string, h: SubscribeHandlers): () => void {
  const es = new EventSource(streamUrl(runId));

  const eventTypes = [
    "phase_change",
    "token",
    "activation",
    "stopped",
    "verdict",
    "done",
    "error",
    "ping",
  ];

  for (const t of eventTypes) {
    es.addEventListener(t, (e: MessageEvent) => {
      if (t === "ping") return;
      try {
        h.onEvent(JSON.parse(e.data));
      } catch (err) {
        console.error("sse parse error", err, e.data);
      }
      if (t === "done" || t === "error") {
        es.close();
        h.onClose?.();
      }
    });
  }

  es.onerror = (err) => {
    h.onError?.(err);
  };

  return () => es.close();
}

export async function startProbe(prompt: string, opts?: {
  max_new_tokens?: number;
  temperature?: number;
  top_p?: number;
  seed?: number;
}): Promise<string> {
  const res = await fetch(probeUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, ...(opts ?? {}) }),
  });
  if (!res.ok) throw new Error(`probe start failed: ${res.status}`);
  const j = await res.json();
  return j.run_id;
}

export async function cancelProbe(runId: string): Promise<void> {
  await fetch(cancelUrl(runId), { method: "POST" });
}
