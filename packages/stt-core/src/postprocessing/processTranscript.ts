import type {
  IntentDetection,
  ScoredSegment,
  SessionContext,
  TransformationLevel,
  UserStylePreferences,
} from "../types";
import { computeTransformationLevel } from "../analysis/transformationDiff";
import { transformToFormat } from "../intent/formatTransformer";
import { classifyIntent } from "../intent/intentClassifier";
import type { CorrectionBudget, CorrectionMode } from "./correctionMode";
import { budgetFor, resolveCorrectionMode } from "./correctionMode";
import { expandContractions } from "./contractionExpander";
import {
  protectionMask,
  tokenize,
  type TextToken,
} from "./entityProtection";
import { cleanupGrammar } from "./grammarCleanup";
import { correctHinglish, looksHinglish } from "./hinglishCorrector";
import type {
  AdaptiveRulesView,
  CorrectionLogEntry,
  ProcessTranscriptConfig,
  ProcessTranscriptInput,
  ProcessTranscriptResult,
} from "./processTypes";
import { splitLongSentences } from "./sentenceReconstruction";
import { detectIntentHybrid } from "./intentDetection";
import { formatByIntent } from "./formatTranscript";
import { applyReplacements } from "./applyReplacements";

const SHORT_INPUT_GUARD_WORDS = 5;

/**
 * Unified post-processing pass. Runs in a single tokenization + mutation walk
 * through the text to keep latency bounded and to avoid conflicting edits
 * across stages.
 *
 * Strict no-hallucination invariant: the `correctedText` body never introduces
 * words that were not in `rawText`. Scaffolding tokens (email template,
 * meeting-notes header, bullet symbols) appear only in `formattedOutput` and
 * are audit-logged with `kind: "scaffolding"`.
 */
export function processTranscript(
  input: ProcessTranscriptInput,
): ProcessTranscriptResult {
  const rawText = input.text;
  const depth: "light" | "full" = input.depth ?? "full";

  // Short-input guard — skip formatting entirely for < 5 words.
  if (wordCount(rawText) < SHORT_INPUT_GUARD_WORDS) {
    return shortInputResult(rawText);
  }

  const config: ProcessTranscriptConfig = input.config ?? {};
  const stylePreferences = input.stylePreferences;
  const hinglishEnabled = resolveHinglishFlag(input);
  const aggregateMode = aggregateModeFromSegments(input.segments);
  const budget: CorrectionBudget = budgetFor(aggregateMode);

  // Apply adaptive replacements BEFORE tokenization so every downstream stage
  // sees the user's preferred form. Replacements are also applied to each
  // segment's text so the pause-aware paragraph formatter sees them too.
  const replacements = input.adaptiveRules?.replacements;
  const textForPipeline = applyReplacements(rawText, replacements);
  const segmentsForPipeline = replacements
    ? input.segments.map((s) => ({ ...s, text: applyReplacements(s.text, replacements) }))
    : input.segments;

  const state: TokenStageState = {
    tokens: tokenize(textForPipeline),
    mask: [],
    corrections: [],
  };
  state.mask = protectionMask(state.tokens);

  const ctx: TokenStageContext = {
    config,
    depth,
    hinglishEnabled,
    aggregateMode,
    budget,
    stylePreferences,
    adaptiveRules: input.adaptiveRules,
  };

  for (const stage of TOKEN_STAGES) {
    stage(state, ctx);
  }

  const correctedText = renderTokens(state.tokens);

  const intent = detectIntent({
    correctedText,
    segments: segmentsForPipeline,
    sessionContext: input.sessionContext,
    stylePreferences,
    adaptiveBias: input.adaptiveRules?.intentBias,
    enabled: config.intentDetection !== false,
  });

  const format = transformFormat({
    correctedText,
    intent,
    depth,
    enabled: config.formatTransformation !== false,
  });
  state.corrections.push(...format.scaffolding);

  const diff = computeTransformationLevel(
    rawText,
    format.output,
    state.corrections,
  );

  const intentResult = detectIntentHybrid(segmentsForPipeline, correctedText);
  const formattedText = formatByIntent(
    intentResult,
    segmentsForPipeline,
    correctedText,
  );

  return {
    rawText,
    correctedText,
    detectedIntent: intent,
    formattedOutput: format.output,
    corrections: state.corrections,
    hinglishApplied: hinglishEnabled,
    transformationLevel: diff.level,
    formatIntent: intentResult.primary,
    intent: intentResult,
    formattedText,
  };
}

// ── Token pipeline ───────────────────────────────────────────────────────────

interface TokenStageState {
  tokens: TextToken[];
  mask: boolean[];
  corrections: CorrectionLogEntry[];
}

interface TokenStageContext {
  config: ProcessTranscriptConfig;
  depth: "light" | "full";
  hinglishEnabled: boolean;
  aggregateMode: CorrectionMode;
  budget: CorrectionBudget;
  stylePreferences?: UserStylePreferences;
  adaptiveRules?: AdaptiveRulesView;
}

type TokenStage = (state: TokenStageState, ctx: TokenStageContext) => void;

const hinglishCorrection: TokenStage = (state, ctx) => {
  if (!ctx.hinglishEnabled) return;
  const r = correctHinglish(state.tokens, state.mask, {
    budget: ctx.budget,
    mode: ctx.aggregateMode,
    overrides: ctx.adaptiveRules?.hinglishDictionaryOverrides,
  });
  state.tokens = r.tokens;
  state.corrections.push(...r.corrections);
};

const grammarCleanup: TokenStage = (state, ctx) => {
  if (ctx.config.grammarCleanup === false) return;
  const fillerExceptions = ctx.adaptiveRules?.fillerExceptions
    ? new Set(ctx.adaptiveRules.fillerExceptions.map((s) => s.toLowerCase()))
    : undefined;
  const limitedBudget: CorrectionBudget = {
    ...ctx.budget,
    allowFillerRemoval:
      ctx.budget.allowFillerRemoval && ctx.config.removeFillers !== false,
  };
  const r = cleanupGrammar(state.tokens, state.mask, {
    budget: limitedBudget,
    mode: ctx.aggregateMode,
    fillerExceptions,
  });
  state.tokens = r.tokens;
  state.corrections.push(...r.corrections);
};

const sentenceSplitting: TokenStage = (state, ctx) => {
  if (ctx.config.sentenceSplitting === false) return;
  if (ctx.depth !== "full") return;
  const r = splitLongSentences(state.tokens, state.mask, {
    budget: ctx.budget,
    mode: ctx.aggregateMode,
    prefersShortSentences: ctx.stylePreferences?.prefersShortSentences === true,
  });
  state.tokens = r.tokens;
  state.corrections.push(...r.corrections);
};

const contractionExpansion: TokenStage = (state, ctx) => {
  if (ctx.config.contractionExpansion === false) return;
  const r = expandContractions(state.tokens, state.mask, {
    budget: ctx.budget,
    mode: ctx.aggregateMode,
    tone: ctx.stylePreferences?.tone,
  });
  state.tokens = r.tokens;
  state.corrections.push(...r.corrections);
};

const TOKEN_STAGES: readonly TokenStage[] = [
  hinglishCorrection,
  grammarCleanup,
  sentenceSplitting,
  contractionExpansion,
];

// ── Finalized-text stages ────────────────────────────────────────────────────

interface DetectIntentArgs {
  correctedText: string;
  segments: ScoredSegment[];
  sessionContext?: SessionContext;
  stylePreferences?: UserStylePreferences;
  adaptiveBias?: AdaptiveRulesView["intentBias"];
  enabled: boolean;
}

function detectIntent(args: DetectIntentArgs): IntentDetection {
  if (!args.enabled) {
    return {
      intent: "paragraph",
      confidence: 0,
      signals: { triggers: [], structural: [] },
    };
  }
  return classifyIntent({
    text: args.correctedText,
    segments: args.segments,
    sessionContext: args.sessionContext,
    stylePreferences: args.stylePreferences,
    adaptiveBias: args.adaptiveBias,
  });
}

interface TransformFormatArgs {
  correctedText: string;
  intent: IntentDetection;
  depth: "light" | "full";
  enabled: boolean;
}

function transformFormat(args: TransformFormatArgs): {
  output: string;
  scaffolding: CorrectionLogEntry[];
} {
  if (!args.enabled) {
    return { output: args.correctedText, scaffolding: [] };
  }
  return transformToFormat({
    text: args.correctedText,
    intent: args.intent,
    depth: args.depth,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function shortInputResult(rawText: string): ProcessTranscriptResult {
  const cleanedPassage = rawText.trim().replace(/\s+/g, " ");
  const capitalized = cleanedPassage
    ? cleanedPassage[0]!.toUpperCase() + cleanedPassage.slice(1)
    : cleanedPassage;
  const withPunct = /[.!?]$/.test(capitalized)
    ? capitalized
    : capitalized
    ? `${capitalized}.`
    : capitalized;
  const corrections: CorrectionLogEntry[] = [];
  if (withPunct !== rawText) {
    corrections.push({
      kind: "casing",
      from: rawText,
      to: withPunct,
      mode: "strict",
    });
  }
  const level: TransformationLevel = "low";
  return {
    rawText,
    correctedText: withPunct,
    detectedIntent: {
      intent: "paragraph",
      confidence: 0,
      signals: { triggers: [], structural: [] },
    },
    formattedOutput: withPunct,
    corrections,
    hinglishApplied: false,
    transformationLevel: level,
    formatIntent: "NOTE",
    intent: { primary: "NOTE" },
    formattedText: withPunct,
  };
}

function resolveHinglishFlag(input: ProcessTranscriptInput): boolean {
  const flag = input.config?.hinglish ?? "auto";
  if (flag === true) return true;
  if (flag === false) return false;
  const lang = (input.language ?? "").toLowerCase();
  if (lang === "hi" || lang === "hinglish") return true;
  if (input.mixesLanguages === true) return true;
  return looksHinglish(input.text);
}

function aggregateModeFromSegments(segments: ScoredSegment[]): CorrectionMode {
  if (segments.length === 0) return "neutral";
  let mostRestrictive: CorrectionMode = "assertive";
  for (const seg of segments) {
    const mode = resolveCorrectionMode(seg);
    if (mode === "strict") return "strict";
    if (mode === "neutral" && mostRestrictive === "assertive") {
      mostRestrictive = "neutral";
    }
  }
  return mostRestrictive;
}

function renderTokens(tokens: TextToken[]): string {
  return tokens.map((t) => t.text).join("").replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
}
