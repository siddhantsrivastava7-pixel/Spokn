// Map a FlowContext to the post-processing knobs that already exist in
// stt-core. No core changes needed — every flag lives under PostProcessingRequest
// (including stylePreferences.tone), reached via /api/transcribe.

import type { PostProcessingRequest } from "./types";

export type FlowContext = "chat" | "email" | "notes";

export function postProcessingForContext(ctx: FlowContext): PostProcessingRequest {
  switch (ctx) {
    case "chat":
      return {
        removeFillers: true,
        grammarCleanup: true,
        formatTransformation: false,
        intentDetection: false,
        stylePreferences: { tone: "casual" },
      };
    case "email":
      return {
        removeFillers: true,
        grammarCleanup: true,
        formatTransformation: true,
        intentDetection: true,
        stylePreferences: { tone: "formal" },
      };
    case "notes":
      return {
        removeFillers: true,
        grammarCleanup: false,
        formatTransformation: true,
        intentDetection: true,
        stylePreferences: { tone: "neutral", prefersLists: true },
      };
  }
}

/**
 * Single source-of-truth selection: pick the response field that should be
 * injected. For notes/email, the formatted output (with paragraph breaks /
 * bullets) is preferred when present; for chat, the cleaned text reads more
 * naturally without scaffolding.
 */
export function pickInjectionText(
  raw: { correctedText?: string; formattedOutput?: string; fullText?: string },
  ctx: FlowContext
): string {
  if (ctx === "notes" || ctx === "email") {
    if (raw.formattedOutput && raw.formattedOutput.trim().length > 0) {
      return raw.formattedOutput;
    }
  }
  if (raw.correctedText && raw.correctedText.length > 0) return raw.correctedText;
  return raw.fullText ?? "";
}
