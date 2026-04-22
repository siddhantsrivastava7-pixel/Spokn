import type { STTModelMetadata } from "../types";

// ─── Risk classification ──────────────────────────────────────────────────────

/**
 * How likely a user from this country is to code-switch (mix languages)
 * even when they select a single primary language.
 * "high" = frequent code-switching; "none" = essentially monolingual.
 */
export type MultilingualRisk = "high" | "medium" | "low" | "none";

/**
 * Countries where code-switching is extremely common in everyday speech.
 * A user saying "English" often means "English mixed with their native language."
 */
const HIGH_CODE_SWITCH_COUNTRIES = new Set([
  "IN", // India — Hindi/English, 20+ regional langs
  "PK", // Pakistan — Urdu/English
  "NG", // Nigeria — English + ~500 local langs
  "PH", // Philippines — Filipino/English (Taglish)
  "SG", // Singapore — English/Mandarin/Malay/Tamil
  "MY", // Malaysia — Malay/English/Mandarin
  "BD", // Bangladesh — Bangla/English
  "LK", // Sri Lanka — Sinhala/Tamil/English
  "GH", // Ghana — English + Akan/Twi/etc.
  "KE", // Kenya — Swahili/English
]);

/**
 * Countries with significant multilingual populations but less pervasive
 * code-switching than the high-risk group.
 */
const MEDIUM_CODE_SWITCH_COUNTRIES = new Set([
  "ZA", // South Africa — 11 official languages
  "CM", // Cameroon — French/English + 250 local langs
  "TZ", // Tanzania — Swahili/English
  "UG", // Uganda — English + 40 local langs
  "ET", // Ethiopia — Amharic + many others
  "RW", // Rwanda — Kinyarwanda/French/English
  "MW", // Malawi — Chichewa/English
  "NP", // Nepal — Nepali/English + many others
  "BE", // Belgium — Dutch/French/German
  "CH", // Switzerland — German/French/Italian/Romansh
  "LU", // Luxembourg — Lëtzebuergesch/French/German
]);

/**
 * English-dominant countries where a user picking "English" genuinely means
 * English-only. English-specific models can safely be preferred here.
 */
const ENGLISH_DOMINANT_COUNTRIES = new Set([
  "US", "AU", "GB", "CA", "NZ", "IE",
]);

/**
 * Countries with a single dominant non-English language.
 * A user here who selects a language still may benefit from a multilingual
 * model for accent/accent-adjacent handling.
 */
const MONO_NON_ENGLISH_COUNTRIES = new Set([
  "JP", "KR", "CN", "TW", // East Asia
  "DE", "AT",              // German-speaking
  "FR",                    // French
  "IT",                    // Italian
  "ES", "MX", "AR", "CO", // Spanish-speaking
  "BR", "PT",              // Portuguese
  "RU", "UA",              // Slavic
  "TR",                    // Turkish
  "SA", "AE", "EG",        // Arabic
  "IR",                    // Persian/Farsi
  "PL", "CZ", "SK", "HU", // Central European
]);

// ─── Public helpers ───────────────────────────────────────────────────────────

/** Returns the code-switching risk level for a country. */
export function getMultilingualRisk(countryCode: string | undefined): MultilingualRisk {
  if (!countryCode) return "low"; // unknown → treat as low risk
  const code = countryCode.toUpperCase();
  if (HIGH_CODE_SWITCH_COUNTRIES.has(code)) return "high";
  if (MEDIUM_CODE_SWITCH_COUNTRIES.has(code)) return "medium";
  if (ENGLISH_DOMINANT_COUNTRIES.has(code)) return "none";
  if (MONO_NON_ENGLISH_COUNTRIES.has(code)) return "low";
  return "low"; // unknown countries default to low
}

/**
 * Additive adjustment to multilingual need (0–1) based on country risk.
 * Positive = more likely to need multilingual; negative = less likely.
 * Caller clamps the result to [0, 1].
 */
export function regionMultilingualAdjustment(countryCode: string | undefined): number {
  const risk = getMultilingualRisk(countryCode);
  switch (risk) {
    case "high":   return +0.30; // India etc.: strong push toward multilingual
    case "medium": return +0.15; // Moderate push
    case "low":    return +0.00; // No adjustment
    case "none":   return -0.10; // English-dominant: slight push toward language-specific
  }
}

/**
 * Score a model's fit for a given country context.
 * Returns a delta score and reasons. Score range: approximately -15 to +15.
 */
export function scoreRegionFit(
  model: STTModelMetadata,
  countryCode: string | undefined,
  adjustedMultilingualNeed: number // already region-adjusted, 0-1
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const risk = getMultilingualRisk(countryCode);
  const isMultilingual = model.capabilities.supportedLanguages.includes("multilingual");

  // No adjustment for unknown countries or no meaningful risk
  if (!countryCode || risk === "low") {
    return { score: 0, reasons };
  }

  let score = 0;

  if (risk === "none") {
    // English-dominant country: reward language-specific fast models
    if (!isMultilingual) {
      score += 8;
      reasons.push(`English-dominant region (${countryCode}) — language-specific model preferred`);
    }
  } else if (risk === "medium" || risk === "high") {
    const riskBonus = risk === "high" ? 15 : 8;
    if (isMultilingual && adjustedMultilingualNeed > 0.4) {
      score += riskBonus;
      reasons.push(
        `Region ${countryCode} (${risk} code-switching risk) — multilingual model preferred`
      );
    } else if (!isMultilingual && adjustedMultilingualNeed > 0.6) {
      score -= riskBonus;
      reasons.push(
        `Region ${countryCode} (${risk} code-switching risk) — language-limited model penalized`
      );
    }
  }

  return { score, reasons };
}
