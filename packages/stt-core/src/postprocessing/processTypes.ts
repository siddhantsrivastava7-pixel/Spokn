import type {
  DetectedIntent,
  IntentDetection,
  ScoredSegment,
  SessionContext,
  TransformationLevel,
  UserStylePreferences,
} from "../types";
import type { CorrectionMode } from "./correctionMode";

/**
 * Kinds of corrections the unified post-processing pass may emit.
 *
 * Strict no-hallucination rule: none of these kinds may introduce words into
 * the `correctedText` body. `scaffolding` is the single exception and only
 * appears in `formattedOutput` (email template, meeting-notes header, bullets).
 */
export type CorrectionKind =
  | "hinglish"
  | "casing"
  | "punctuation"
  | "filler"
  | "split"
  | "stopword_collapse"
  | "contraction"
  | "scaffolding";

export interface CorrectionLogEntry {
  kind: CorrectionKind;
  /** Empty for pure insertions (only valid for `scaffolding`). */
  from: string;
  /** Empty for pure removals (e.g. filler removal). */
  to: string;
  /** Absent for scaffolding (no source segment). */
  segmentIndex?: number;
  /** Budget that authorized this edit. `scaffolding` uses "scaffolding" sentinel. */
  mode: CorrectionMode | "scaffolding";
}

export interface ProcessTranscriptInput {
  /** Full text joined from the (possibly reprocessed) segments. */
  text: string;
  /** Segments with tier + reprocess info — drives per-segment correction budgets. */
  segments: ScoredSegment[];
  sessionContext?: SessionContext;
  stylePreferences?: UserStylePreferences;
  /** BCP-47 or "unknown" or stt-core SupportedLanguage. */
  language?: string;
  mixesLanguages?: boolean;
  config?: ProcessTranscriptConfig;
  /** Depth preset — "light" disables intent transformation beyond line breaks. */
  depth?: "light" | "full";
  /** Overrides from the local feedback loop (filler exceptions, dictionary). */
  adaptiveRules?: AdaptiveRulesView;
}

export interface ProcessTranscriptConfig {
  /** "auto" enables when language is hi/hinglish OR mixesLanguages is true. */
  hinglish?: boolean | "auto";
  grammarCleanup?: boolean;
  sentenceSplitting?: boolean;
  removeFillers?: boolean;
  /** Effective only when stylePreferences.tone === "formal". */
  contractionExpansion?: boolean;
  intentDetection?: boolean;
  formatTransformation?: boolean;
}

export interface AdaptiveRulesView {
  fillerExceptions?: string[];
  hinglishDictionaryOverrides?: Record<string, string>;
  intentBias?: Partial<Record<DetectedIntent, number>>;
  /** Whole-word replacements applied before tokenization. */
  replacements?: Record<string, string>;
}

export interface ProcessTranscriptResult {
  rawText: string;
  correctedText: string;
  detectedIntent: IntentDetection;
  formattedOutput: string;
  corrections: CorrectionLogEntry[];
  /** Whether the Hinglish auto-rule fired for this input. */
  hinglishApplied: boolean;
  /** Severity summary — computed by transformationDiff against rawText. */
  transformationLevel: TransformationLevel;
  /**
   * Simple 4-way formatting intent used by `formatByIntent`. Distinct from
   * `detectedIntent` (richer 7-way taxonomy used for scaffolding).
   * Equivalent to `intent?.primary`, preserved for backward compatibility.
   */
  formatIntent?: import("./intentDetection").FormatIntent;
  /**
   * Full multi-intent result from `detectIntentHybrid`. Consumers that care
   * about both primary and secondary (e.g. to render a list-of-commands
   * differently) should read this. Equivalent to `{ primary: formatIntent }`
   * when no secondary was detected.
   */
  intent?: import("./intentDetection").IntentResult;
  /** Output of `formatByIntent` for `intent`. Never modifies rawText. */
  formattedText?: string;
}
