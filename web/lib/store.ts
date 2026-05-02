"use client";

import { create } from "zustand";
import type {
  ActivationEvent,
  DeltaEntry,
  FeatureSummary,
  Phase,
  StreamEvent,
  VerdictEvent,
} from "./types";

export interface ActivationCell {
  layer: number;
  featureId: number;
  position: number;
  strength: number;
  phase: Phase;
}

export interface RunState {
  runId: string | null;
  prompt: string;
  rendered: string;
  phase: Phase;
  thinkingTokens: { decoded: string; position: number }[];
  outputTokens: { decoded: string; position: number }[];
  cells: ActivationCell[];
  phaseDividerPosition: number | null;
  totalTokens: number;
  isRunning: boolean;
  stoppedReason: string | null;
  verdict: VerdictEvent | null;
  error: string | null;
}

interface Actions {
  start: (runId: string, prompt: string) => void;
  apply: (evt: StreamEvent) => void;
  reset: () => void;
}

const initial: RunState = {
  runId: null,
  prompt: "",
  rendered: "",
  phase: "prompt",
  thinkingTokens: [],
  outputTokens: [],
  cells: [],
  phaseDividerPosition: null,
  totalTokens: 0,
  isRunning: false,
  stoppedReason: null,
  verdict: null,
  error: null,
};

/**
 * Module-level buffer for incoming activation cells.
 *
 * Why: a long run produces ~13 hooked layers × 20 top-K × ~250 tokens ≈ 65 000
 * cells. If every activation event triggers `cells: [...s.cells, ...new]`, the
 * whole array is copied per event — O(n²) overall. Chromium tolerates this;
 * Safari/WebKit hits GC pressure and locks the page up around the 30-50s mark.
 *
 * Instead: push activations into a buffer, drain into the store at most every
 * FLUSH_MS milliseconds. One re-render per 100ms regardless of event rate.
 * Tokens and phase changes still apply immediately so the transcripts feel
 * live.
 */
const FLUSH_MS = 100;
let activationBuffer: ActivationCell[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush() {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (activationBuffer.length === 0) return;
    const drained = activationBuffer;
    activationBuffer = [];
    useRun.setState((s) => ({ cells: s.cells.concat(drained) }));
  }, FLUSH_MS);
}

function clearActivationBuffer() {
  activationBuffer = [];
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

export const useRun = create<RunState & Actions>((set) => ({
  ...initial,

  start: (runId, prompt) => {
    clearActivationBuffer();
    set({
      ...initial,
      runId,
      prompt,
      isRunning: true,
    });
  },

  reset: () => {
    clearActivationBuffer();
    set(initial);
  },

  apply: (evt) => {
    switch (evt.type) {
      case "phase_change": {
        if (evt.to === "output" && evt.from === "thinking") {
          set({ phase: evt.to, phaseDividerPosition: evt.position });
        } else {
          set({ phase: evt.to });
        }
        return;
      }
      case "token": {
        const tok = { decoded: evt.decoded, position: evt.position };
        if (evt.phase === "thinking") {
          set((s) => ({
            thinkingTokens: [...s.thinkingTokens, tok],
            totalTokens: s.totalTokens + 1,
          }));
        } else if (evt.phase === "output") {
          set((s) => ({
            outputTokens: [...s.outputTokens, tok],
            totalTokens: s.totalTokens + 1,
          }));
        }
        return;
      }
      case "activation": {
        // Buffer; the flush timer will drain into the store.
        const a = evt as ActivationEvent;
        for (const f of a.features) {
          activationBuffer.push({
            layer: a.layer,
            featureId: f.id,
            position: a.position,
            strength: f.strength,
            phase: a.phase,
          });
        }
        scheduleFlush();
        return;
      }
      case "verdict": {
        set({ verdict: evt });
        return;
      }
      case "stopped": {
        set({ stoppedReason: evt.reason, isRunning: false });
        return;
      }
      case "done": {
        // Drain any remaining buffered activations into the final state so
        // the polygraph + delta numbers settle on the complete picture before
        // the user clicks View Verdict.
        if (activationBuffer.length > 0) {
          const drained = activationBuffer;
          activationBuffer = [];
          set((s) => ({ cells: s.cells.concat(drained), isRunning: false }));
        } else {
          set({ isRunning: false });
        }
        return;
      }
      case "error": {
        set({ error: evt.message, isRunning: false });
        return;
      }
    }
  },
}));

export type { FeatureSummary, DeltaEntry };
