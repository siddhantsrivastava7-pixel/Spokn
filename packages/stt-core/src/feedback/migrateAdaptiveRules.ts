import type { DetectedIntent } from "../types";
import type { AdaptiveRules } from "./feedbackTypes";

const KNOWN_INTENTS: ReadonlySet<DetectedIntent> = new Set<DetectedIntent>([
  "paragraph",
  "bullet_list",
  "numbered_list",
  "todo_list",
  "email",
  "message",
  "meeting_notes",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickFillerExceptions(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function pickHinglishOverrides(v: unknown): Record<string, string> {
  if (!isObject(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

function pickIntentBias(
  v: unknown,
): Partial<Record<DetectedIntent, number>> {
  if (!isObject(v)) return {};
  const out: Partial<Record<DetectedIntent, number>> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "number" || !Number.isFinite(val)) continue;
    if (!KNOWN_INTENTS.has(k as DetectedIntent)) continue;
    out[k as DetectedIntent] = val;
  }
  return out;
}

/**
 * Lossy loader for persisted `AdaptiveRules` data. Coerces unknown input
 * to a safe v1 shape: drops unknown fields, type-checks known fields,
 * falls back to empty rules on bad input. Never throws.
 */
export function migrateAdaptiveRules(raw: unknown): AdaptiveRules {
  if (!isObject(raw)) {
    return {
      schemaVersion: 1,
      fillerExceptions: [],
      hinglishDictionaryOverrides: {},
      intentBias: {},
    };
  }

  return {
    schemaVersion: 1,
    fillerExceptions: pickFillerExceptions(raw.fillerExceptions),
    hinglishDictionaryOverrides: pickHinglishOverrides(
      raw.hinglishDictionaryOverrides,
    ),
    intentBias: pickIntentBias(raw.intentBias),
  };
}
