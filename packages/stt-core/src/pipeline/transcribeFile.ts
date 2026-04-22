import type {
  AudioQualityMetrics,
  IntentDetection,
  ScoredSegment,
  STTModelMetadata,
  STTRuntimeAdapter,
  SupportedLanguage,
  TranscriptionMode,
  TranscriptionResult,
  TranscriptionSettings,
  TransformationLevel,
  Transcript,
  TranscriptSegment,
} from "../types";
import type {
  PipelineLogger,
  TranscribeFileParams,
} from "./pipelineTypes";
import { validateSettings, mergeWithDefaults } from "../settings/validateSettings";
import { chooseModel } from "../routing/chooseModel";
import { planChunks, needsChunking } from "../audio/chunkAudio";
import { mergeChunkResponses } from "../audio/mergeChunks";
import { transcribeSegment } from "./transcribeSegments";
import { finalizeTranscript } from "./finalizeTranscript";
import { getModelById } from "../models/modelRegistry";
import { scoreSegments, aggregateTier } from "../analysis/segmentConfidence";
import { LatencyBudget } from "./latencyBudget";
import { presetFor, type ProcessingModePreset } from "./processingModes";
import { selectiveReprocess } from "./selectiveReprocess";
import { processTranscript } from "../postprocessing/processTranscript";
import type { CorrectionLogEntry } from "../postprocessing/processTypes";
import { buildFullText } from "../transcript/transcriptUtils";

const DEFAULT_AUDIO_DURATION_GUARD_MS = 120_000;

/**
 * Top-level entry point for file transcription.
 *
 * Orchestrates the full pipeline. The high-level contract:
 *   - Never throws. Any stage failure returns a transcript with
 *     fallbackUsed: true and fallbackStage set.
 *   - Emits onPartial(v1) after the initial adapter call and onPartial(v2)
 *     after selective reprocessing (when enabled).
 *   - Respects the latency budget derived from processingMode.
 */
export async function transcribeFile(
  params: TranscribeFileParams,
): Promise<TranscriptionResult> {
  const logger = resolveLogger(params.logger, params.debugMode === true);
  const preset = presetFor(params.processingMode);
  const budgetMs =
    params.postProcessing?.latencyBudgetMs ?? preset.latencyBudgetMs;
  const budget = new LatencyBudget(budgetMs);
  const audioDurationGuardMs =
    params.audioDurationGuardMs ?? DEFAULT_AUDIO_DURATION_GUARD_MS;
  const durationMs = params.input.durationMs ?? 0;
  const longAudio = durationMs > 0 && durationMs > audioDurationGuardMs;
  const settings = mergeWithDefaults(params.settings);

  const settingsValidation = validateSettings(settings);
  if (!settingsValidation.valid) {
    return fallbackAt({
      stage: "settings",
      error: `Invalid settings: ${settingsValidation.errors.join("; ")}`,
      modelId: "unknown",
      mode: settings.mode,
      segments: [],
      language: "unknown",
      totalDurationMs: 0,
      chunksProcessed: 1,
      processingMode: params.processingMode ?? "balanced",
      budget,
    });
  }

  const routing = await runRouting(params, settings, logger);
  budget.mark("routing");
  if (routing.kind === "error") {
    return fallbackAt({
      stage: "routing",
      error: routing.error,
      modelId: "unknown",
      mode: settings.mode,
      segments: [],
      language: "unknown",
      totalDurationMs: 0,
      chunksProcessed: 1,
      processingMode: params.processingMode ?? "balanced",
      budget,
    });
  }

  const primary = await runPrimaryTranscription({
    params,
    settings,
    chain: routing.fallbackChain,
    durationMs,
    logger,
  });
  budget.mark("transcribe");
  if (primary.kind === "error") {
    return fallbackAt({
      stage: "transcribe",
      error: primary.error,
      modelId: routing.fallbackChain[0] ?? "unknown",
      mode: routing.selectionResult.resolvedMode.mode,
      segments: [],
      language: "unknown",
      totalDurationMs: 0,
      chunksProcessed: 1,
      processingMode: params.processingMode ?? "balanced",
      budget,
      modelFallbackChain: routing.fallbackChain,
    });
  }

  const scoring = scoreSegments(
    primary.segments,
    routing.selectionResult.selectedModel.capabilities.confidenceScale,
  );
  let scoredSegments: ScoredSegment[] = scoring.segments;
  budget.mark("score");

  emitPartial({
    params,
    segments: scoredSegments,
    language: primary.language,
    totalDurationMs: primary.totalDurationMs,
    modelId: primary.modelIdUsed,
    mode: routing.selectionResult.resolvedMode.mode,
    qualityTier: scoring.qualityTier,
    processingMode: params.processingMode ?? "balanced",
    version: 1,
    budget,
    metadata: buildMetadata(routing.selectionResult, scoring.counts),
    modelFallbackChain: primary.modelFallbackChainUsed,
    audioQuality: primary.audioQuality,
    preprocessing: primary.preprocessing,
    logger,
    partialLabel: "v1",
  });

  const reprocess = await maybeReprocess({
    params,
    preset,
    scoredSegments,
    settings,
    longAudio,
    modelIdUsed: primary.modelIdUsed,
    budget,
    logger,
  });
  scoredSegments = reprocess.segments;
  budget.mark("reprocess");

  const qualityTier = aggregateTier(countsByTier(scoredSegments));

  emitPartial({
    params,
    segments: scoredSegments,
    language: primary.language,
    totalDurationMs: primary.totalDurationMs,
    modelId: primary.modelIdUsed,
    mode: routing.selectionResult.resolvedMode.mode,
    qualityTier,
    processingMode: params.processingMode ?? "balanced",
    version: 2,
    budget,
    metadata: buildMetadata(routing.selectionResult, countsByTier(scoredSegments)),
    downgrades: [...budget.downgrades, ...reprocess.downgrades],
    modelFallbackChain: primary.modelFallbackChainUsed,
    audioQuality: primary.audioQuality,
    preprocessing: primary.preprocessing,
    logger,
    partialLabel: "v2",
  });

  const depth: "light" | "full" =
    longAudio || preset.postProcessingDepth === "light" ? "light" : "full";

  const post = runPostProcessing({
    scoredSegments,
    settings,
    params,
    depth,
    logger,
  });
  budget.mark("postprocess");

  if (post.kind === "error") {
    return fallbackAt({
      stage: "postprocess",
      error: post.error,
      modelId: primary.modelIdUsed,
      mode: routing.selectionResult.resolvedMode.mode,
      segments: scoredSegments,
      language: primary.language,
      totalDurationMs: primary.totalDurationMs,
      chunksProcessed: primary.chunksProcessed,
      processingMode: params.processingMode ?? "balanced",
      budget,
      modelFallbackChain: primary.modelFallbackChainUsed,
    });
  }

  return finalizeResult({
    scoredSegments,
    language: primary.language,
    totalDurationMs: primary.totalDurationMs,
    modelIdUsed: primary.modelIdUsed,
    mode: routing.selectionResult.resolvedMode.mode,
    qualityTier,
    processingMode: params.processingMode ?? "balanced",
    budget,
    reprocess,
    postResult: post.result,
    selectionResult: routing.selectionResult,
    modelFallbackChain: primary.modelFallbackChainUsed,
    audioQuality: primary.audioQuality,
    preprocessing: primary.preprocessing,
    chunksProcessed: primary.chunksProcessed,
  });
}

// ── Phase 1: Routing ────────────────────────────────────────────────────────

type RoutingOutcome =
  | {
      kind: "ok";
      selectionResult: ReturnType<typeof chooseModel>;
      installedIds: string[];
      fallbackChain: string[];
    }
  | { kind: "error"; error: string };

async function runRouting(
  params: TranscribeFileParams,
  settings: TranscriptionSettings,
  logger: PipelineLogger,
): Promise<RoutingOutcome> {
  let installedIds: string[];
  try {
    installedIds = await params.runtimeAdapter.getAvailableModelIds();
  } catch (err) {
    logger.error("transcribeFile: getAvailableModelIds failed", { err: asErr(err) });
    installedIds = [];
  }

  try {
    const selectionResult = chooseModel({
      settings,
      device: params.deviceProfile,
      userSpeechProfile: params.userSpeechProfile,
      installedModelIds: installedIds,
    });
    const fallbackChain = buildModelFallbackChain(
      selectionResult.selectedModel,
      selectionResult.fallbackCandidates,
      installedIds,
    );
    return { kind: "ok", selectionResult, installedIds, fallbackChain };
  } catch (err) {
    return { kind: "error", error: asErr(err) };
  }
}

function buildModelFallbackChain(
  primary: STTModelMetadata,
  fallbackCandidates: STTModelMetadata[],
  installedIds: string[],
): string[] {
  const installed = new Set(installedIds);
  const chain: string[] = [primary.id];
  const sortedFallbacks = fallbackCandidates
    .filter((m) => m.id !== primary.id && installed.has(m.id))
    .sort((a, b) => a.sizeMB - b.sizeMB);
  for (const m of sortedFallbacks) {
    if (!chain.includes(m.id)) chain.push(m.id);
  }
  return chain;
}

function pickEscalationModel(
  installedIds: string[],
  primaryModelId: string,
): string | undefined {
  const primaryMeta = getModelById(primaryModelId);
  if (!primaryMeta) return undefined;
  const candidates = installedIds
    .map(getModelById)
    .filter((m): m is STTModelMetadata => !!m)
    .filter((m) => m.id !== primaryModelId)
    .filter((m) => m.sizeMB > primaryMeta.sizeMB);
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.sizeMB - a.sizeMB);
  return candidates[0]?.id;
}

// ── Phase 2: Primary transcription ──────────────────────────────────────────

type PrimaryOutcome =
  | {
      kind: "ok";
      segments: TranscriptSegment[];
      language: string;
      totalDurationMs: number;
      chunksProcessed: number;
      modelIdUsed: string;
      modelFallbackChainUsed?: string[];
      audioQuality?: AudioQualityMetrics;
      preprocessing?: Transcript["preprocessing"];
    }
  | { kind: "error"; error: string };

async function runPrimaryTranscription(args: {
  params: TranscribeFileParams;
  settings: TranscriptionSettings;
  chain: string[];
  durationMs: number;
  logger: PipelineLogger;
}): Promise<PrimaryOutcome> {
  const { params, settings, chain, durationMs, logger } = args;
  const tried: string[] = [];
  let lastError = "unknown";

  for (const modelId of chain) {
    tried.push(modelId);
    try {
      const result = await runAdapterOnce({
        runtimeAdapter: params.runtimeAdapter,
        audioPath: params.input.audioPath,
        language: settings.language,
        timestamps: settings.timestamps,
        sampleRate: params.input.sampleRate,
        prompt: settings.prompt,
        chunkDurationMs: settings.chunkDurationMs ?? 60_000,
        durationMs,
        modelId,
      });
      return {
        kind: "ok",
        ...result,
        modelIdUsed: modelId,
        modelFallbackChainUsed: tried.length > 1 ? tried : undefined,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn("transcribeFile: adapter failed, trying next model", {
        modelId,
        err: lastError,
      });
    }
  }

  return { kind: "error", error: lastError };
}

async function runAdapterOnce(args: {
  runtimeAdapter: STTRuntimeAdapter;
  audioPath: string;
  language: SupportedLanguage;
  timestamps: boolean;
  sampleRate?: number;
  prompt?: string;
  chunkDurationMs: number;
  durationMs: number;
  modelId: string;
}): Promise<{
  segments: TranscriptSegment[];
  language: string;
  totalDurationMs: number;
  chunksProcessed: number;
  audioQuality?: AudioQualityMetrics;
  preprocessing?: Transcript["preprocessing"];
}> {
  const shouldChunk =
    args.durationMs > 0 && needsChunking(args.durationMs, args.chunkDurationMs);

  if (shouldChunk) {
    const plan = planChunks({
      audioPath: args.audioPath,
      totalDurationMs: args.durationMs,
      chunkDurationMs: args.chunkDurationMs,
    });

    const chunkResults = await Promise.all(
      plan.chunks.map((chunk) =>
        transcribeSegment({
          audioPath: chunk.audioPath,
          modelId: args.modelId,
          language: args.language,
          timestamps: args.timestamps,
          startMs: chunk.startMs,
          endMs: chunk.endMs,
          sampleRate: args.sampleRate,
          prompt: args.prompt,
          runtimeAdapter: args.runtimeAdapter,
        }).then((response) => ({ response, chunkStartMs: chunk.startMs })),
      ),
    );

    const merged = mergeChunkResponses(chunkResults);
    return {
      segments: merged.segments,
      language: merged.language,
      totalDurationMs: merged.totalDurationMs,
      chunksProcessed: plan.chunks.length,
    };
  }

  const response = await transcribeSegment({
    audioPath: args.audioPath,
    modelId: args.modelId,
    language: args.language,
    timestamps: args.timestamps,
    sampleRate: args.sampleRate,
    prompt: args.prompt,
    runtimeAdapter: args.runtimeAdapter,
  });

  const out: {
    segments: TranscriptSegment[];
    language: string;
    totalDurationMs: number;
    chunksProcessed: number;
    audioQuality?: AudioQualityMetrics;
    preprocessing?: Transcript["preprocessing"];
  } = {
    segments: response.segments,
    language: response.language,
    totalDurationMs: response.durationMs,
    chunksProcessed: 1,
  };
  if (response.audioQuality) out.audioQuality = response.audioQuality;
  if (response.preprocessing) out.preprocessing = response.preprocessing;
  return out;
}

// ── Phase 3: Selective reprocess (optional) ─────────────────────────────────

interface ReprocessOutcome {
  segments: ScoredSegment[];
  downgrades: string[];
  reprocessedCount: number;
  escalationModelIdUsed?: string;
}

async function maybeReprocess(args: {
  params: TranscribeFileParams;
  preset: ProcessingModePreset;
  scoredSegments: ScoredSegment[];
  settings: TranscriptionSettings;
  longAudio: boolean;
  modelIdUsed: string;
  budget: LatencyBudget;
  logger: PipelineLogger;
}): Promise<ReprocessOutcome> {
  const { params, preset, scoredSegments, settings, longAudio, modelIdUsed, budget, logger } = args;
  const enabled =
    (params.postProcessing?.selectiveReprocess ?? preset.selectiveReprocess) &&
    !longAudio;

  if (!enabled) {
    return {
      segments: scoredSegments,
      downgrades: longAudio ? ["long_audio_light_path"] : [],
      reprocessedCount: 0,
    };
  }

  try {
    const result = await selectiveReprocess(scoredSegments, {
      runtimeAdapter: params.runtimeAdapter,
      audioPath: params.input.audioPath,
      language: settings.language,
      timestamps: settings.timestamps,
      sampleRate: params.input.sampleRate,
      prompt: settings.prompt,
      primaryModelId: modelIdUsed,
      reprocessModelId: params.postProcessing?.reprocessModelId,
      maxSegmentsToReprocess: params.postProcessing?.maxSegmentsToReprocess ?? 3,
      concurrency: params.postProcessing?.reprocessConcurrency,
      budget,
      pickEscalationModel: (installed) =>
        pickEscalationModel(installed, modelIdUsed),
    });
    const outcome: ReprocessOutcome = {
      segments: result.segments,
      downgrades: result.downgrades,
      reprocessedCount: result.reprocessedCount,
    };
    if (result.escalationModelId !== undefined) {
      outcome.escalationModelIdUsed = result.escalationModelId;
    }
    return outcome;
  } catch (err) {
    logger.error("transcribeFile: selectiveReprocess threw", { err: asErr(err) });
    return {
      segments: scoredSegments,
      downgrades: ["reprocess_stage_error"],
      reprocessedCount: 0,
    };
  }
}

// ── Phase 4: Post-processing ────────────────────────────────────────────────

interface PostProcessingSuccess {
  kind: "ok";
  result: {
    correctedText: string;
    formattedOutput: string;
    detectedIntent?: IntentDetection;
    transformationLevel?: TransformationLevel;
    corrections: CorrectionLogEntry[];
  };
}
interface PostProcessingError {
  kind: "error";
  error: string;
}

function runPostProcessing(args: {
  scoredSegments: ScoredSegment[];
  settings: TranscriptionSettings;
  params: TranscribeFileParams;
  depth: "light" | "full";
  logger: PipelineLogger;
}): PostProcessingSuccess | PostProcessingError {
  const { scoredSegments, settings, params, depth, logger } = args;
  try {
    const pp = processTranscript({
      text: buildFullText(scoredSegments),
      segments: scoredSegments,
      sessionContext: params.postProcessing?.sessionContext,
      stylePreferences:
        params.postProcessing?.stylePreferences ??
        params.userSpeechProfile?.stylePreferences,
      language: settings.language,
      mixesLanguages: params.userSpeechProfile?.mixesLanguages,
      depth,
      adaptiveRules: params.adaptiveRules,
      config: {
        hinglish: params.postProcessing?.hinglishCorrection ?? "auto",
        grammarCleanup: params.postProcessing?.grammarCleanup,
        sentenceSplitting: params.postProcessing?.sentenceSplitting,
        removeFillers: params.postProcessing?.removeFillers,
        contractionExpansion: params.postProcessing?.contractionExpansion,
        intentDetection: params.postProcessing?.intentDetection,
        formatTransformation: params.postProcessing?.formatTransformation,
      },
    });
    return {
      kind: "ok",
      result: {
        correctedText: pp.correctedText,
        formattedOutput: pp.formattedOutput,
        detectedIntent: pp.detectedIntent,
        transformationLevel: pp.transformationLevel,
        corrections: pp.corrections,
      },
    };
  } catch (err) {
    logger.error("transcribeFile: processTranscript threw", { err: asErr(err) });
    return { kind: "error", error: asErr(err) };
  }
}

// ── Phase 5: Finalize ────────────────────────────────────────────────────────

function finalizeResult(args: {
  scoredSegments: ScoredSegment[];
  language: string;
  totalDurationMs: number;
  modelIdUsed: string;
  mode: TranscriptionMode;
  qualityTier: ReturnType<typeof aggregateTier>;
  processingMode: NonNullable<TranscribeFileParams["processingMode"]>;
  budget: LatencyBudget;
  reprocess: ReprocessOutcome;
  postResult: PostProcessingSuccess["result"];
  selectionResult: ReturnType<typeof chooseModel>;
  modelFallbackChain: string[] | undefined;
  audioQuality: AudioQualityMetrics | undefined;
  preprocessing: Transcript["preprocessing"];
  chunksProcessed: number;
}): TranscriptionResult {
  const downgrades = [...args.budget.downgrades, ...args.reprocess.downgrades];

  const transcript = finalizeTranscript({
    segments: args.scoredSegments,
    language: args.language,
    durationMs: args.totalDurationMs,
    modelId: args.modelIdUsed,
    mode: args.mode,
    qualityTier: args.qualityTier,
    processingMode: args.processingMode,
    isFinal: true,
    version: 3,
    latencyMs: args.budget.elapsed(),
    latencyBreakdown: args.budget.breakdown(),
    downgrades: downgrades.length > 0 ? downgrades : undefined,
    // Canonical cleaned text — becomes Transcript.correctedText (and the
    // deprecated Transcript.fullText alias). Plain text only: no scaffolding,
    // no snippet expansion, no user edits — those live at the UI layer.
    correctedText: args.postResult.correctedText,
    formattedOutput: args.postResult.formattedOutput,
    detectedIntent: args.postResult.detectedIntent,
    transformationLevel: args.postResult.transformationLevel,
    audioQuality: args.audioQuality,
    preprocessing: args.preprocessing,
    metadata: {
      ...buildMetadata(args.selectionResult, countsByTier(args.scoredSegments)),
      reprocessedCount: args.reprocess.reprocessedCount,
      escalationModelIdUsed: args.reprocess.escalationModelIdUsed,
      corrections: args.postResult.corrections,
    },
    modelFallbackChain: args.modelFallbackChain,
  });

  return {
    transcript,
    processingTimeMs: args.budget.elapsed(),
    modelId: args.modelIdUsed,
    chunksProcessed: args.chunksProcessed,
  };
}

// ── Partial emission ─────────────────────────────────────────────────────────

function emitPartial(args: {
  params: TranscribeFileParams;
  segments: ScoredSegment[];
  language: string;
  totalDurationMs: number;
  modelId: string;
  mode: TranscriptionMode;
  qualityTier: ReturnType<typeof aggregateTier>;
  processingMode: NonNullable<TranscribeFileParams["processingMode"]>;
  version: number;
  budget: LatencyBudget;
  metadata: Record<string, unknown>;
  downgrades?: string[];
  modelFallbackChain: string[] | undefined;
  audioQuality: AudioQualityMetrics | undefined;
  preprocessing: Transcript["preprocessing"];
  logger: PipelineLogger;
  partialLabel: string;
}): void {
  if (!args.params.onPartial) return;
  try {
    args.params.onPartial(
      finalizeTranscript({
        segments: args.segments,
        language: args.language,
        durationMs: args.totalDurationMs,
        modelId: args.modelId,
        mode: args.mode,
        qualityTier: args.qualityTier,
        processingMode: args.processingMode,
        isFinal: false,
        version: args.version,
        latencyMs: args.budget.elapsed(),
        latencyBreakdown: args.budget.breakdown(),
        metadata: args.metadata,
        downgrades: args.downgrades,
        modelFallbackChain: args.modelFallbackChain,
        audioQuality: args.audioQuality,
        preprocessing: args.preprocessing,
      }),
    );
  } catch (err) {
    args.logger.warn(`transcribeFile: onPartial(${args.partialLabel}) threw`, {
      err: asErr(err),
    });
  }
}

// ── Fallback transcript construction ─────────────────────────────────────────

function fallbackAt(args: {
  stage: string;
  error: string;
  modelId: string;
  mode: TranscriptionMode;
  segments: ScoredSegment[];
  language: string;
  totalDurationMs: number;
  chunksProcessed: number;
  processingMode: NonNullable<TranscribeFileParams["processingMode"]>;
  budget: LatencyBudget;
  modelFallbackChain?: string[];
}): TranscriptionResult {
  const transcript = finalizeTranscript({
    segments: args.segments,
    language: args.language,
    durationMs: args.totalDurationMs,
    modelId: args.modelId,
    mode: args.mode,
    processingMode: args.processingMode,
    isFinal: true,
    version: 3,
    fallbackUsed: true,
    fallbackStage: args.stage,
    fallbackError: redactError(args.error),
    latencyMs: args.budget.elapsed(),
    latencyBreakdown: args.budget.breakdown(),
    modelFallbackChain: args.modelFallbackChain,
    metadata: {},
  });
  return {
    transcript,
    processingTimeMs: args.budget.elapsed(),
    modelId: args.modelId,
    chunksProcessed: args.chunksProcessed,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function countsByTier(segments: ScoredSegment[]): Record<
  "HIGH" | "MEDIUM" | "LOW",
  number
> {
  const out = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const s of segments) out[s.tier] += 1;
  return out;
}

function buildMetadata(
  selectionResult: ReturnType<typeof chooseModel>,
  tierCounts: Record<string, number>,
): Record<string, unknown> {
  return {
    resolvedMode: selectionResult.resolvedMode.mode,
    modeReason: selectionResult.resolvedMode.reason,
    selectionReasons: selectionResult.selectionReasons,
    appliedBiases: selectionResult.appliedBiases,
    fallbackCandidates: selectionResult.fallbackCandidates.map((m) => m.id),
    tierCounts,
  };
}

function redactError(raw: string): string {
  return raw.replace(/[A-Z]:\\[^\s]+/g, "<path>").slice(0, 400);
}

function asErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolveLogger(
  logger: PipelineLogger | undefined,
  debug: boolean,
): PipelineLogger {
  if (logger) return logger;
  if (debug) {
    /* eslint-disable no-console */
    return {
      info: (m, d) => console.info(m, d ?? {}),
      warn: (m, d) => console.warn(m, d ?? {}),
      error: (m, d) => console.error(m, d ?? {}),
    };
    /* eslint-enable no-console */
  }
  return { info: noop, warn: noop, error: noop };
}

function noop(): void {
  /* no-op */
}
