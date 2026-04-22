import type { STTModelMetadata, LatencyTier } from "../types";
import type { ModelSelectionContext, ResolvedTranscriptionMode, ScoredModel } from "../types/routingTypes";
import { computeMultilingualNeed, scoreLanguageFit } from "./languageProfile";
import { scoreRegionFit } from "./regionHeuristics";
import { scoreBatteryFit, scoreStorageFit } from "./preferenceHeuristics";

// ─── Score weights ────────────────────────────────────────────────────────────
// Each sub-scorer returns points in its listed range.
// Weights are documented here rather than scattered so they can be tuned centrally.
//
//   MODE_FIT        ±40 — primary concern; latency tier vs. mode intent
//   MULTILINGUAL    ±30 — language need fit; most important personalization signal
//   REGION          ±15 — code-switching risk per country
//   BATTERY          ±10 — battery impact preference (device or user)
//   STORAGE          ±10 — model size preference
//
// Approximate total range: -105 to +105 per model.

// Latency tier numeric rank: lower = faster
const LATENCY_RANK: Record<LatencyTier, number> = {
  realtime: 0,
  fast:     1,
  normal:   2,
  slow:     3,
};

// ─── Mode fit ────────────────────────────────────────────────────────────────

/**
 * How well a model's latency tier matches the resolved mode intent.
 * Score range: -40 to +40.
 */
function scoreModeFit(
  model: STTModelMetadata,
  mode: ResolvedTranscriptionMode
): { score: number; reasons: string[] } {
  const tier = model.capabilities.latencyTier;
  const rank = LATENCY_RANK[tier];
  const reasons: string[] = [];
  let score = 0;

  switch (mode) {
    case "fast":
      // Ideal: realtime (+40), fast (+25), normal (-10), slow (-25)
      score = rank === 0 ? 40 : rank === 1 ? 25 : rank === 2 ? -10 : -25;
      break;

    case "balanced":
      // Ideal: fast (+30), realtime (+20), normal (+20), slow (-15)
      score = rank === 1 ? 30 : rank <= 2 ? 20 : -15;
      break;

    case "best_accuracy":
      // Ideal: slow (+40), normal (+25), fast (0), realtime (-15)
      // Larger, slower models are presumed to be more accurate
      score = rank === 3 ? 40 : rank === 2 ? 25 : rank === 1 ? 0 : -15;
      break;
  }

  reasons.push(`Mode "${mode}": ${tier} latency → ${score > 0 ? "+" : ""}${score} pts`);
  return { score, reasons };
}

// ─── Device capacity match ────────────────────────────────────────────────────

/**
 * Rewards larger models on devices that can comfortably run them.
 * Prevents 64 GB RAM looking the same as 4 GB to the scorer.
 * Score range: 0 to +20.
 */
function scoreDeviceCapacity(
  model: STTModelMetadata,
  device: { ramMB: number; gpuVramMB?: number; gpuVendor?: string }
): { score: number; reasons: string[] } {
  const profile = model.capabilities.memoryProfile;
  const reasons: string[] = [];
  let bonus = 0;

  // RAM headroom bonus — only activates on 8 GB+ devices
  if (device.ramMB >= 8_192) {
    const ramBonus = profile === "large" ? 20 : profile === "medium" ? 12 : profile === "small" ? 5 : 0;
    if (ramBonus > 0) {
      bonus += ramBonus;
      reasons.push(`High-RAM device (${Math.round(device.ramMB / 1024)} GB) — "${profile}" model preferred (+${ramBonus} pts)`);
    }
  }

  // GPU VRAM bonus — dedicated NVIDIA/AMD GPU gives large models an extra lift
  // because whisper.cpp and ONNX runtimes can offload inference to the GPU
  const vramMB = device.gpuVramMB ?? 0;
  const hasDedicatedGpu = vramMB >= 2_048 && (device.gpuVendor === "nvidia" || device.gpuVendor === "amd");
  if (hasDedicatedGpu) {
    const gpuBonus = profile === "large" ? 25 : profile === "medium" ? 15 : profile === "small" ? 5 : 0;
    if (gpuBonus > 0) {
      bonus += gpuBonus;
      reasons.push(`${device.gpuVendor?.toUpperCase()} GPU (${Math.round(vramMB / 1024)} GB VRAM) — "${profile}" model preferred (+${gpuBonus} pts)`);
    }
  }

  return { score: bonus, reasons };
}

// ─── Composite scorer ────────────────────────────────────────────────────────

/**
 * Scores a single candidate model against the full selection context.
 * Higher score = better fit. Stage 2 sorts by this score descending.
 */
export function scoreModel(
  model: STTModelMetadata,
  context: ModelSelectionContext,
  resolvedMode: ResolvedTranscriptionMode
): ScoredModel {
  const { settings, device, userSpeechProfile: profile } = context;
  const countryCode = profile?.countryCode;

  const allReasons: string[] = [];
  let totalScore = 0;

  // ── Mode fit ──────────────────────────────────────────────────────────────
  const modeFit = scoreModeFit(model, resolvedMode);
  totalScore += modeFit.score;
  allReasons.push(...modeFit.reasons);

  // ── Multilingual need ─────────────────────────────────────────────────────
  const multilingualNeed = computeMultilingualNeed(settings, profile, countryCode);
  const langFit = scoreLanguageFit(model, multilingualNeed, settings.language);
  totalScore += langFit.score;
  allReasons.push(...langFit.reasons);

  // ── Region heuristic ──────────────────────────────────────────────────────
  const regionFit = scoreRegionFit(model, countryCode, multilingualNeed);
  totalScore += regionFit.score;
  allReasons.push(...regionFit.reasons);

  // ── Battery preference ────────────────────────────────────────────────────
  const batteryFit = scoreBatteryFit(model, device, profile);
  totalScore += batteryFit.score;
  allReasons.push(...batteryFit.reasons);

  // ── Storage preference ────────────────────────────────────────────────────
  const storageFit = scoreStorageFit(model, profile);
  totalScore += storageFit.score;
  allReasons.push(...storageFit.reasons);

  // ── Device capacity match ─────────────────────────────────────────────────
  // On high-RAM devices, reward larger models that make better use of available
  // hardware. Score range: 0 to +20. Only activates when device has headroom.
  const capacityFit = scoreDeviceCapacity(model, device);
  totalScore += capacityFit.score;
  allReasons.push(...capacityFit.reasons);

  return {
    model,
    totalScore,
    reasons: allReasons.filter(Boolean),
  };
}

/**
 * Scores all compatible candidates and returns them sorted best-first.
 * Also returns which personalization biases were active.
 */
export function rankCandidates(
  candidates: STTModelMetadata[],
  context: ModelSelectionContext,
  resolvedMode: ResolvedTranscriptionMode
): { ranked: ScoredModel[]; appliedBiases: string[] } {
  const { settings, device, userSpeechProfile: profile } = context;
  const countryCode = profile?.countryCode;

  const scored = candidates.map((m) => scoreModel(m, context, resolvedMode));
  scored.sort((a, b) => b.totalScore - a.totalScore);

  // Collect which biases were actually active in this selection
  const biases: string[] = [];
  const need = computeMultilingualNeed(settings, profile, countryCode);

  if (need >= 0.5) biases.push(`multilingual-bias:${need >= 0.85 ? "high" : "medium"}`);
  if (countryCode) biases.push(`region:${countryCode}`);
  if (device.batterySaverActive || device.lowPowerMode || profile?.prefersLowBatteryUsage) {
    biases.push("battery-preference");
  }
  if (profile?.prefersLowStorageUsage) biases.push("storage-preference");
  if (profile?.mixesLanguages) biases.push("code-switching-detected");

  return { ranked: scored, appliedBiases: biases };
}
