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
    // Anti-hallucination thresholds. Always-on, not gated on highAccuracy —
    // these block the generation path where Whisper confabulates on silence
    // (Japanese YouTube sign-offs, "thanks for watching", etc.). Values are
    // conservative defaults; highAccuracy may override via appendDecodingHints
    // and the trailing dedupe keeps the last occurrence.
    "--no-speech-thold", "0.6",
    "--logprob-thold",  "-1.0",
    "--entropy-thold",  "2.4",
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

  return dedupeThresholdFlags(args);
}

/**
 * Narrow, scoped dedupe for the three anti-hallucination threshold flags only.
 *
 * Contract:
 *   - Collapses duplicates of ONLY `--no-speech-thold`, `--logprob-thold`,
 *     `--entropy-thold` — every other flag (including `--beam-size`,
 *     `--best-of`, `--temperature`, `-l`, `-f`, `-m`, boolean flags like
 *     `-oj` / `--split-on-word`, etc.) is passed through untouched.
 *   - Relative order of all non-threshold flags is preserved exactly.
 *   - For each threshold flag that appears more than once, keeps the LAST
 *     occurrence (so `highAccuracy` overrides the baseline cleanly).
 *
 * This is NOT a generic "dedupe any duplicate flag" pass. A generic dedupe
 * could silently change unrelated CLI behavior if any future flag legitimately
 * repeats (e.g. `--suppress-tokens` can be passed multiple times). Keep this
 * function targeted; add new entries to `thresholdFlags` only when a flag is
 * known to be emitted by more than one branch with the same semantics.
 */
function dedupeThresholdFlags(args: string[]): string[] {
  const thresholdFlags = new Set([
    "--no-speech-thold",
    "--logprob-thold",
    "--entropy-thold",
  ]);
  const lastIndex = new Map<string, number>();
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (thresholdFlags.has(tok)) lastIndex.set(tok, i);
  }
  if (lastIndex.size === 0) return args;

  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (thresholdFlags.has(tok) && lastIndex.get(tok) !== i) {
      i++; // skip the value paired with this duplicate threshold flag
      continue;
    }
    out.push(tok);
  }
  return out;
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
