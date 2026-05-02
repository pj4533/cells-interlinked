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
  // first-time-seen position per (layer, feature) pair → polygraph row slot key
  // (the polygraph component itself maps these to its 40 pre-allocated slots)
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

export const useRun = create<RunState & Actions>((set) => ({
  ...initial,

  start: (runId, prompt) =>
    set({
      ...initial,
      runId,
      prompt,
      isRunning: true,
    }),

  reset: () => set(initial),

  apply: (evt) => {
    set((s) => {
      switch (evt.type) {
        case "phase_change": {
          if (evt.to === "output" && evt.from === "thinking") {
            return { phase: evt.to, phaseDividerPosition: evt.position };
          }
          return { phase: evt.to };
        }
        case "token": {
          const tok = { decoded: evt.decoded, position: evt.position };
          if (evt.phase === "thinking") {
            return {
              thinkingTokens: [...s.thinkingTokens, tok],
              totalTokens: s.totalTokens + 1,
            };
          } else if (evt.phase === "output") {
            return {
              outputTokens: [...s.outputTokens, tok],
              totalTokens: s.totalTokens + 1,
            };
          }
          return {};
        }
        case "activation": {
          // Append a cell per fired feature for this (layer, position).
          const a = evt as ActivationEvent;
          const newCells = a.features.map((f) => ({
            layer: a.layer,
            featureId: f.id,
            position: a.position,
            strength: f.strength,
            phase: a.phase,
          }));
          return { cells: [...s.cells, ...newCells] };
        }
        case "verdict": {
          return { verdict: evt };
        }
        case "stopped": {
          return { stoppedReason: evt.reason, isRunning: false };
        }
        case "done": {
          return { isRunning: false };
        }
        case "error": {
          return { error: evt.message, isRunning: false };
        }
        default:
          return {};
      }
    });
  },
}));

export type { FeatureSummary, DeltaEntry };
