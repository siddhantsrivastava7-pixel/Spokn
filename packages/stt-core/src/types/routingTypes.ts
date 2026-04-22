import type { STTModelMetadata, TranscriptionMode, TranscriptionSettings, DeviceProfile } from "./index";
import type { UserSpeechProfile } from "./userSpeechProfile";

// ─── Mode resolution ──────────────────────────────────────────────────────────

/** Concrete mode — "auto" has been resolved, so it never appears here. */
export type ResolvedTranscriptionMode = Exclude<TranscriptionMode, "auto">;

/** Result of resolving "auto" (or validating an explicit mode choice). */
export interface ResolvedMode {
  mode: ResolvedTranscriptionMode;
  /** Human-readable explanation of why this mode was chosen. */
  reason: string;
}

// ─── Routing input ────────────────────────────────────────────────────────────

/**
 * Everything the routing engine needs to make a model selection.
 * Replaces the old ad-hoc (settings, device, installedIds?) parameter list.
 */
export interface ModelSelectionContext {
  settings: TranscriptionSettings;
  device: DeviceProfile;
  /** Optional — routing works without it but is less personalized. */
  userSpeechProfile?: UserSpeechProfile;
  /** When provided, routing only considers models the runtime has installed. */
  installedModelIds?: string[];
}

// ─── Routing output ───────────────────────────────────────────────────────────

export interface RejectedCandidate {
  modelId: string;
  /** Concrete reason this model was excluded (hard constraint or score detail). */
  reason: string;
}

/**
 * Structured routing result. Provides full transparency into why a model was
 * selected so callers can surface this info in debug views or logs.
 */
export interface ModelSelectionResult {
  selectedModel: STTModelMetadata;
  /** The concrete mode that was used for scoring (auto already resolved). */
  resolvedMode: ResolvedMode;
  /** Ordered list of reasons the selected model won — most important first. */
  selectionReasons: string[];
  /** Other compatible models, sorted by score (best first). */
  fallbackCandidates: STTModelMetadata[];
  /** Models that were excluded and why. */
  rejectedCandidates: RejectedCandidate[];
  /**
   * Labels for each personalization signal that influenced the final ranking.
   * e.g. "multilingual-bias:high", "region:IN", "battery-preference"
   */
  appliedBiases: string[];
}

// ─── Internal scoring ─────────────────────────────────────────────────────────

/** Intermediate scoring output for a single candidate model. */
export interface ScoredModel {
  model: STTModelMetadata;
  totalScore: number;
  reasons: string[];
}
