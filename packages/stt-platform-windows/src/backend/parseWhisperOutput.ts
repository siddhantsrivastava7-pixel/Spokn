import * as fs from "fs";
import type { TranscriptSegment } from "@stt/core";
import type { BackendTranscriptionResponse } from "./backendTypes";
import { OutputParseError } from "../errors";

/**
 * Shape of whisper.cpp JSON output (whisper-cli -oj flag).
 * Covers whisper.cpp v1.5+ output format.
 */
interface WhisperJsonOutput {
  result?: {
    language?: string;
  };
  transcription?: WhisperSegment[];
  systeminfo?: string;
}

interface WhisperSegment {
  timestamps?: {
    from: string; // "00:00:00,000"
    to: string;
  };
  offsets?: {
    from: number; // ms
    to: number;
  };
  text: string;
  tokens?: WhisperToken[];
  // Optional decoder-level signals. whisper.cpp may emit these either at the
  // top level of the segment or nested under `metrics` / `confidence`,
  // depending on the build. We accept both snake_case and camelCase.
  avg_logprob?: number;
  avgLogprob?: number;
  no_speech_prob?: number;
  noSpeechProb?: number;
  compression_ratio?: number;
  compressionRatio?: number;
  metrics?: {
    avg_logprob?: number;
    avgLogprob?: number;
    no_speech_prob?: number;
    noSpeechProb?: number;
    compression_ratio?: number;
    compressionRatio?: number;
  };
}

interface WhisperToken {
  text: string;
  p?: number; // per-token probability
}

/**
 * Reads the JSON file whisper-cli writes alongside the audio input.
 * whisper-cli names it <audioPath>.json (e.g., sample.wav.json).
 */
export async function parseWhisperJsonFile(
  audioPath: string
): Promise<BackendTranscriptionResponse> {
  // whisper-cli strips the input extension, so foo.webm → foo.json.
  // --output-file is set to the same stripped path in buildWhisperArgs.
  const jsonPath = audioPath.replace(/\.[^.]+$/, "") + ".json";

  let raw: string;
  try {
    raw = await fs.promises.readFile(jsonPath, "utf-8");
  } catch (err) {
    throw new OutputParseError(
      `whisper.cpp JSON output not found at: ${jsonPath}`,
      ""
    );
  }

  return parseWhisperJsonString(raw);
}

/**
 * Parses a whisper.cpp JSON string.
 * Exported separately so tests can drive it without touching the filesystem.
 */
export function parseWhisperJsonString(
  raw: string
): BackendTranscriptionResponse {
  let parsed: WhisperJsonOutput;
  try {
    parsed = JSON.parse(raw) as WhisperJsonOutput;
  } catch {
    throw new OutputParseError("whisper.cpp JSON is not valid JSON", raw.slice(0, 500));
  }

  if (!parsed.transcription || !Array.isArray(parsed.transcription)) {
    throw new OutputParseError(
      "whisper.cpp JSON missing 'transcription' array",
      raw.slice(0, 500)
    );
  }

  const segments: TranscriptSegment[] = parsed.transcription.map((seg) => {
    const startMs = seg.offsets?.from ?? parseTimestamp(seg.timestamps?.from ?? "00:00:00,000");
    const endMs = seg.offsets?.to ?? parseTimestamp(seg.timestamps?.to ?? "00:00:00,000");
    const text = seg.text.trim();
    const confidence = computeSegmentConfidence(seg.tokens);

    const result: TranscriptSegment = { startMs, endMs, text };
    if (confidence !== undefined) result.confidence = confidence;

    const avgLogprob = pickDecoderSignal(seg, "avg_logprob", "avgLogprob");
    if (avgLogprob !== undefined) result.avgLogprob = avgLogprob;
    const noSpeechProb = pickDecoderSignal(seg, "no_speech_prob", "noSpeechProb");
    if (noSpeechProb !== undefined) result.noSpeechProb = noSpeechProb;
    const compressionRatio = pickDecoderSignal(seg, "compression_ratio", "compressionRatio");
    if (compressionRatio !== undefined) result.compressionRatio = compressionRatio;

    return result;
  });

  const detectedLanguage = parsed.result?.language ?? "unknown";
  const durationMs = segments.length > 0
    ? Math.max(...segments.map((s) => s.endMs))
    : 0;

  const overallConfidence = computeOverallConfidence(segments);

  const response: BackendTranscriptionResponse = {
    segments,
    detectedLanguage,
    durationMs,
    rawOutput: raw,
  };
  if (overallConfidence !== undefined) {
    response.confidence = overallConfidence;
  }
  return response;
}

/** Parses "HH:MM:SS,mmm" timestamp to milliseconds. */
function parseTimestamp(ts: string): number {
  // Format: "00:01:23,456" or "00:01:23.456"
  const match = ts.match(/^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return 0;
  const [, h, m, s, ms] = match.map(Number);
  return ((h * 3600 + m * 60 + s) * 1000) + ms;
}

function computeSegmentConfidence(
  tokens?: WhisperToken[]
): number | undefined {
  if (!tokens || tokens.length === 0) return undefined;
  const probs = tokens
    .map((t) => t.p)
    .filter((p): p is number => typeof p === "number" && p > 0);
  if (probs.length === 0) return undefined;
  return probs.reduce((a, b) => a + b, 0) / probs.length;
}

function computeOverallConfidence(
  segments: TranscriptSegment[]
): number | undefined {
  const confs = segments
    .map((s) => s.confidence)
    .filter((c): c is number => typeof c === "number");
  if (confs.length === 0) return undefined;
  return confs.reduce((a, b) => a + b, 0) / confs.length;
}

/**
 * Pick a numeric decoder signal from a whisper segment, tolerant of both
 * snake_case/camelCase and of an optional `metrics` nesting level.
 * Returns undefined if no usable value is present — never guesses a default.
 */
function pickDecoderSignal(
  seg: WhisperSegment,
  snake: "avg_logprob" | "no_speech_prob" | "compression_ratio",
  camel: "avgLogprob" | "noSpeechProb" | "compressionRatio",
): number | undefined {
  const segRecord = seg as unknown as Record<string, unknown>;
  const metricsRecord =
    seg.metrics !== undefined ? (seg.metrics as unknown as Record<string, unknown>) : undefined;
  const sources: Array<unknown> = [
    segRecord[snake],
    segRecord[camel],
    metricsRecord?.[snake],
    metricsRecord?.[camel],
  ];
  for (const v of sources) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}
