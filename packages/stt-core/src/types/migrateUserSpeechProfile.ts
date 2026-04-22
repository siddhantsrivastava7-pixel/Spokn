import type { UserSpeechProfile, UserStylePreferences } from "./userSpeechProfile";

type PreferredMode = NonNullable<UserSpeechProfile["preferredMode"]>;
const PREFERRED_MODES: ReadonlySet<PreferredMode> = new Set([
  "auto",
  "fast",
  "balanced",
  "best_accuracy",
]);

type Tone = NonNullable<UserStylePreferences["tone"]>;
const TONES: ReadonlySet<Tone> = new Set(["casual", "formal", "neutral"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function pickBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function pickStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
}

function pickStylePreferences(v: unknown): UserStylePreferences | undefined {
  if (!isObject(v)) return undefined;
  const out: UserStylePreferences = {};
  const prefersLists = pickBoolean(v.prefersLists);
  if (prefersLists !== undefined) out.prefersLists = prefersLists;
  const prefersShortSentences = pickBoolean(v.prefersShortSentences);
  if (prefersShortSentences !== undefined) out.prefersShortSentences = prefersShortSentences;
  const tone = pickString(v.tone);
  if (tone && TONES.has(tone as Tone)) out.tone = tone as Tone;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Lossy loader for persisted `UserSpeechProfile` data. Coerces unknown
 * input to a safe v1 shape: drops unknown fields, type-checks known fields,
 * falls back to an empty profile on bad input. Never throws.
 */
export function migrateUserSpeechProfile(raw: unknown): UserSpeechProfile {
  if (!isObject(raw)) {
    return { schemaVersion: 1 };
  }

  const out: UserSpeechProfile = { schemaVersion: 1 };

  const region = pickString(raw.region);
  if (region !== undefined) out.region = region;

  const countryCode = pickString(raw.countryCode);
  if (countryCode !== undefined) out.countryCode = countryCode;

  const primaryLanguages = pickStringArray(raw.primaryLanguages);
  if (primaryLanguages !== undefined) out.primaryLanguages = primaryLanguages;

  const secondaryLanguages = pickStringArray(raw.secondaryLanguages);
  if (secondaryLanguages !== undefined) out.secondaryLanguages = secondaryLanguages;

  const mixesLanguages = pickBoolean(raw.mixesLanguages);
  if (mixesLanguages !== undefined) out.mixesLanguages = mixesLanguages;

  const preferredMode = pickString(raw.preferredMode);
  if (preferredMode && PREFERRED_MODES.has(preferredMode as PreferredMode)) {
    out.preferredMode = preferredMode as PreferredMode;
  }

  const prefersLowBatteryUsage = pickBoolean(raw.prefersLowBatteryUsage);
  if (prefersLowBatteryUsage !== undefined) out.prefersLowBatteryUsage = prefersLowBatteryUsage;

  const prefersLowStorageUsage = pickBoolean(raw.prefersLowStorageUsage);
  if (prefersLowStorageUsage !== undefined) out.prefersLowStorageUsage = prefersLowStorageUsage;

  const stylePreferences = pickStylePreferences(raw.stylePreferences);
  if (stylePreferences !== undefined) out.stylePreferences = stylePreferences;

  return out;
}
