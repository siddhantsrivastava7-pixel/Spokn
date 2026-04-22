import { spawn } from "child_process";
import { cleanupTempFile, makeTempPath } from "../utils/tempFiles";

export interface PreprocessOptions {
  targetSampleRate: 16000;
  mono: true;
  /** Apply loudnorm for volume normalization. */
  normalize: boolean;
  /** Apply silenceremove to trim leading silence. */
  trimSilence: boolean;
  /** Reserved — phase-1 skips noise reduction (arnndn needs a model file). */
  noiseReduction?: boolean;
}

export const DEFAULT_PREPROCESS_OPTIONS: PreprocessOptions = {
  targetSampleRate: 16000,
  mono: true,
  normalize: true,
  trimSilence: true,
};

export interface PreprocessInput {
  ffmpegPath: string;
  inputPath: string;
  options?: Partial<PreprocessOptions>;
  /** Max wall-clock time to wait for ffmpeg. Default 10 seconds. */
  timeoutMs?: number;
}

export interface PreprocessResult {
  /** Path to the cleaned WAV. Caller owns its lifetime via the `cleanup` fn. */
  cleanedPath: string;
  /** Stages that were actually applied, in order — used for audit. */
  stages: string[];
  /** Call this to remove the cleaned file when transcription is done. */
  cleanup: () => Promise<void>;
}

/**
 * Produces a 16 kHz mono WAV from the input, with optional loudnorm + silence
 * trimming applied. The cleaned file is written to the platform temp dir and
 * the caller is responsible for cleanup via the returned fn.
 */
export async function preprocessAudio(
  input: PreprocessInput,
): Promise<PreprocessResult> {
  const opts: PreprocessOptions = {
    ...DEFAULT_PREPROCESS_OPTIONS,
    ...(input.options ?? {}),
  };
  const outputPath = await makeTempPath(".wav");

  const filters: string[] = [];
  const stages: string[] = [];
  if (opts.mono) stages.push("mono");
  stages.push(`resample:${opts.targetSampleRate}`);
  if (opts.normalize) {
    filters.push("loudnorm=I=-16:TP=-1.5:LRA=11");
    stages.push("normalize");
  }
  if (opts.trimSilence) {
    filters.push(
      "silenceremove=start_periods=1:start_silence=0.2:start_threshold=-50dB",
    );
    stages.push("trim_silence");
  }

  const args: string[] = [
    "-y",
    "-hide_banner",
    "-nostats",
    "-loglevel", "error",
    "-i", input.inputPath,
    "-ac", opts.mono ? "1" : "2",
    "-ar", String(opts.targetSampleRate),
  ];
  if (filters.length > 0) {
    args.push("-af", filters.join(","));
  }
  args.push(outputPath);

  try {
    await runFfmpeg(input.ffmpegPath, args, input.timeoutMs ?? 10_000);
  } catch (err) {
    await cleanupTempFile(outputPath).catch(() => {});
    throw err;
  }

  return {
    cleanedPath: outputPath,
    stages,
    cleanup: () => cleanupTempFile(outputPath),
  };
}

function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true, shell: false });
    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ffmpeg preprocess timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
        reject(new Error(`ffmpeg preprocess failed (${code}): ${stderr.slice(0, 300)}`));
        return;
      }
      resolve();
    });
  });
}
