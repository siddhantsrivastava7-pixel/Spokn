import type { BackendTranscriptionRequest } from "./backendTypes";

/**
 * Maps a BackendTranscriptionRequest to whisper-cli CLI arguments.
 *
 * whisper.cpp strips the input extension when naming output files, so
 * `foo.webm` → `foo.json`, not `foo.webm.json`. We pass --output-file
 * explicitly so we always know the exact output path.
 */
export function buildWhisperArgs(req: BackendTranscriptionRequest): string[] {
  if (req.model.kind !== "whisper-cpp") {
    throw new Error(
      `buildWhisperArgs requires a whisper-cpp model ref, got "${req.model.kind}"`,
    );
  }

  // Derive a stable output base path: strip the audio file's extension.
  // whisper-cli appends .json to whatever --output-file specifies.
  const outputBase = req.audioPath.replace(/\.[^.]+$/, "");

  const args: string[] = [
    "-f", req.audioPath,
    "-m", req.model.path,
    "-oj",                     // output JSON format
    "--output-file", outputBase, // write to <outputBase>.json exactly
    "--no-prints",             // suppress non-error stderr noise
  ];

  // Language
  const lang = normalizeLanguageCode(req.language);
  args.push("-l", lang);

  // Without timestamps flag whisper.cpp still emits start/end in JSON,
  // but adding --split-on-word gives finer segments when requested.
  if (req.timestamps) {
    args.push("--split-on-word");
  }

  // Seed the decoder with a vocabulary/style prompt to improve domain accuracy.
  if (req.prompt && req.prompt.trim()) {
    args.push("--prompt", req.prompt.trim());
  }

  // If the caller specifies an offset (chunk mode), use whisper's offset/duration flags.
  // whisper.cpp uses milliseconds for --offset-t and --duration.
  if (req.startMs !== undefined && req.startMs > 0) {
    args.push("--offset-t", String(req.startMs));
  }
  if (req.startMs !== undefined && req.endMs !== undefined) {
    const durationMs = req.endMs - req.startMs;
    args.push("--duration", String(durationMs));
  }

  // Decoder-accuracy hints — used by selective reprocessing on LOW segments.
  // highAccuracy applies a known-good preset; numeric fields override.
  appendDecodingHints(args, req.decodingHints);

  return args;
}

function appendDecodingHints(
  args: string[],
  hints: BackendTranscriptionRequest["decodingHints"],
): void {
  if (!hints) return;
  let beamSize = hints.beamSize;
  let bestOf = hints.bestOf;
  let temperature = hints.temperature;
  if (hints.highAccuracy) {
    beamSize = beamSize ?? 5;
    bestOf = bestOf ?? 5;
    temperature = temperature ?? 0;
  }
  if (beamSize !== undefined) args.push("--beam-size", String(beamSize));
  if (bestOf !== undefined) args.push("--best-of", String(bestOf));
  if (temperature !== undefined) args.push("--temperature", String(temperature));
  if (hints.highAccuracy) {
    // Tighter fallback thresholds — reduces the chance whisper gives up on a
    // difficult window and resorts to its default text.
    args.push("--entropy-thold", "2.4");
    args.push("--logprob-thold", "-1.0");
  }
}

/**
 * Maps stt-core SupportedLanguage values to whisper.cpp language codes.
 * whisper.cpp uses ISO 639-1 codes or "auto".
 */
function normalizeLanguageCode(lang?: string): string {
  switch (lang) {
    case "en":           return "en";
    case "hi":           return "hi";
    case "hinglish":
    case "multilingual":
    case "auto":
    case undefined:      return "auto";
    default:             return lang; // pass-through for raw BCP-47 codes
  }
}
