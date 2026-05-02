// Mirrors backend SSE event union (server/cells_interlinked/api/routes_probe.py).

export type Phase = "prompt" | "thinking" | "output";

export interface FeatureFire {
  id: number;
  strength: number;
}

export interface PhaseChangeEvent {
  type: "phase_change";
  from: Phase | null;
  to: Phase;
  position: number;
}

export interface TokenEvent {
  type: "token";
  phase: Phase;
  token_id: number;
  decoded: string;
  position: number;
}

export interface ActivationEvent {
  type: "activation";
  phase: Phase;
  position: number;
  layer: number;
  features: FeatureFire[];
}

export interface StoppedEvent {
  type: "stopped";
  reason: "eos" | "max" | "cancelled" | "ring_full" | "error";
  total_tokens: number;
}

export interface FeatureSummary {
  layer: number;
  feature_id: number;
  mean: number;
  max_act: number;
  present_token_count: number;
}

export interface DeltaEntry {
  layer: number;
  feature_id: number;
  thinking_mean: number;
  output_mean: number;
  delta: number;
  thinking_only: boolean;
}

export interface VerdictEvent {
  type: "verdict";
  thinking: FeatureSummary[];
  output: FeatureSummary[];
  deltas: DeltaEntry[];
  thinking_only: DeltaEntry[];
  output_only: DeltaEntry[];
  summary_stats: Record<string, number>;
}

export interface DoneEvent {
  type: "done";
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export type StreamEvent =
  | PhaseChangeEvent
  | TokenEvent
  | ActivationEvent
  | StoppedEvent
  | VerdictEvent
  | DoneEvent
  | ErrorEvent;
