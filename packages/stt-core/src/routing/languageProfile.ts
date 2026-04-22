import type { STTModelMetadata, SupportedLanguage, TranscriptionSettings } from "../types";
import type { UserSpeechProfile } from "../types/userSpeechProfile";
import { regionMultilingualAdjustment } from "./regionHeuristics";

// ─── Multilingual need computation ───────────────────────────────────────────

/**
 * A normalized measure (0–1) of how strongly a model needs to handle
 * more than one language for this user.
 *
 *  0.0 = unambiguously single-language
 *  0.5 = moderate multilingual expectation
 *  1.0 = code-switching guaranteed, multilingual model required
 */
export function computeMultilingualNeed(
  settings: TranscriptionSettings,
  profile: UserSpeechProfile | undefined,
  countryCode: string | undefined
): number {
  let need = 0;

  // ── Signal 1: the language the user requested in settings ────────────────
  switch (settings.language) {
    case "multilingual":
      need = Math.max(need, 1.0); // explicit multilingual request — max need
      break;
    case "hinglish":
      need = Math.max(need, 0.9); // Hindi+English mix — very high
      break;
    case "hi":
      need = Math.max(need, 0.3); // Hindi user — moderate (may have English terms)
      break;
    case "auto":
      need = Math.max(need, 0.3); // auto-detect — we don't know, assume some need
      break;
    case "en":
      // No intrinsic need from language selection alone; other signals may raise it
      break;
  }

  // ── Signal 2: onboarding language profile ────────────────────────────────
  if (profile) {
    const allUserLangs = [
      ...(profile.primaryLanguages ?? []),
      ...(profile.secondaryLanguages ?? []),
    ];

    if (allUserLangs.length > 1) {
      // More languages → higher need. Caps at 0.8 from this signal alone.
      const langCountBoost = Math.min((allUserLangs.length - 1) * 0.2, 0.6);
      need = Math.max(need, langCountBoost);
    }

    // Code-switching is the strongest profile signal
    if (profile.mixesLanguages === true) {
      need = Math.max(need, 0.85);
    }
  }

  // ── Signal 3: region-based adjustment ────────────────────────────────────
  const regionAdj = regionMultilingualAdjustment(countryCode);
  need = Math.min(1, Math.max(0, need + regionAdj));

  return need;
}

// ─── Language fit scoring ────────────────────────────────────────────────────

/**
 * Scores a model's language suitability given the computed multilingual need.
 * Score range: approximately -30 to +30.
 *
 * Scoring philosophy:
 * - High multilingual need → multilingual models win, English-only models lose hard
 * - Low multilingual need → small English-specific models are fine and fast
 * - The penalty for English-only models scales with need so it isn't binary
 */
export function scoreLanguageFit(
  model: STTModelMetadata,
  multilingualNeed: number,
  requestedLanguage: SupportedLanguage
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const isMultilingual = model.capabilities.supportedLanguages.includes("multilingual");

  // ── Hard-ish cases: language explicitly requires multilingual ──────────────
  if (requestedLanguage === "multilingual" || requestedLanguage === "hinglish") {
    if (isMultilingual) {
      return {
        score: 30,
        reasons: [`Model supports multilingual — required for "${requestedLanguage}"`],
      };
    } else {
      // Should have been filtered in stage 1, but score heavily anyway
      return {
        score: -30,
        reasons: [`Model does not support "${requestedLanguage}" — heavy penalty`],
      };
    }
  }

  // ── General scoring: scale with computed need ─────────────────────────────
  let score = 0;

  if (isMultilingual) {
    // Multilingual models get a benefit proportional to how much it's needed.
    // When need is low (English-only user), being multilingual adds minimal value.
    // When need is high, it's a big win.
    const bonus = Math.round(multilingualNeed * 30);
    score += bonus;
    if (bonus > 5) {
      reasons.push(
        `Multilingual model preferred (need=${multilingualNeed.toFixed(2)}, +${bonus} pts)`
      );
    }
  } else {
    // Language-specific model: penalize when multilingual need is high,
    // reward when language need is clearly single-language.
    if (multilingualNeed > 0.5) {
      const penalty = Math.round((multilingualNeed - 0.5) * 2 * 30);
      score -= penalty;
      reasons.push(
        `Language-limited model penalized for multilingual use (need=${multilingualNeed.toFixed(2)}, -${penalty} pts)`
      );
    } else {
      // Low need → fast English model is appropriate
      const bonus = Math.round((0.5 - multilingualNeed) * 20);
      score += bonus;
      if (bonus > 3) {
        reasons.push(
          `Language-specific model fits single-language use (+${bonus} pts)`
        );
      }
    }
  }

  return { score, reasons };
}
