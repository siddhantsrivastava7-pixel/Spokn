import type { ModelSelectionResult, ModelSelectionContext } from "../types/routingTypes";
import { resolveMode } from "./chooseMode";
import { filterCompatibleModels } from "./filterCompatibleModels";
import { rankCandidates } from "./scoreModel";

/**
 * Two-stage model selection engine.
 *
 * Stage 1 — Hard constraint filter (filterCompatibleModels):
 *   Rejects models that violate any hard requirement:
 *   device capability, language support, offline requirement, installation.
 *
 * Stage 2 — Scoring (rankCandidates):
 *   Scores remaining candidates using:
 *   mode intent, multilingual need, region heuristics, battery/storage preferences.
 *
 * Returns a fully reasoned ModelSelectionResult — transparent about what won,
 * what lost, and why.
 */
export function chooseModel(context: ModelSelectionContext): ModelSelectionResult {
  const { settings, device, userSpeechProfile: profile } = context;

  // ── Resolve mode (auto → concrete) ────────────────────────────────────────
  const resolvedMode = resolveMode(settings.mode, device, settings, profile);

  // Use resolved mode for scoring
  const effectiveSettings = { ...settings, mode: resolvedMode.mode };
  const effectiveContext = { ...context, settings: effectiveSettings };

  // ── Stage 1: hard filter ──────────────────────────────────────────────────
  const { compatible, rejected, pinnedModel } = filterCompatibleModels(effectiveContext);

  // exactModelId was validated — return immediately, skipping scoring
  if (pinnedModel) {
    return {
      selectedModel: pinnedModel,
      resolvedMode,
      selectionReasons: [`Pinned by exactModelId setting — "${pinnedModel.displayName}"`],
      fallbackCandidates: [],
      rejectedCandidates: rejected,
      appliedBiases: [],
    };
  }

  if (compatible.length === 0) {
    const rejectedSummary = rejected.map((r) => `${r.modelId}: ${r.reason}`).join("; ");
    throw new Error(
      `No compatible model found for mode="${settings.mode}", language="${settings.language}". ` +
      `Rejected: ${rejectedSummary}`
    );
  }

  // ── Stage 2: score and rank ───────────────────────────────────────────────
  const { ranked, appliedBiases } = rankCandidates(
    compatible,
    effectiveContext,
    resolvedMode.mode
  );

  const [winner, ...rest] = ranked;

  // Top reasons = reasons from the winner that actually moved the score
  const selectionReasons = winner.reasons.filter((r) => {
    // Keep reasons that mention a score change or are substantive
    return r.includes("pts") || r.includes("preferred") || r.includes("required") || r.includes("Pinned");
  });
  if (selectionReasons.length === 0) selectionReasons.push(...winner.reasons.slice(0, 2));

  return {
    selectedModel: winner.model,
    resolvedMode,
    selectionReasons,
    fallbackCandidates: rest.slice(0, 3).map((s) => s.model),
    rejectedCandidates: rejected,
    appliedBiases,
  };
}
