import * as fs from "fs";
import * as path from "path";
import { getAppDataRoot } from "../utils/pathUtils";
import type { LocalSTTBackend, BackendTranscriptionRequest, BackendTranscriptionResponse } from "./backendTypes";
import type { TranscriptSegment } from "@stt/core";
import { getAllModels } from "@stt/core";

const HF_CACHE_DIR = path.join(getAppDataRoot(), "hf-cache");

export interface TransformersJsBackendOptions {
  /** Override HuggingFace cache location. Defaults to %LOCALAPPDATA%/stt-platform-windows/hf-cache */
  cacheDir?: string;
}

/**
 * Inference backend that uses @huggingface/transformers (Transformers.js v3).
 * Downloads models from HuggingFace Hub in ONNX format — no Python required.
 * Used for SenseVoice, MMS, and ONNX-exported Whisper variants.
 *
 * Reads `req.model.modelId` (stt-core registry ID) and resolves it to a
 * HuggingFace repo ID via the registry's `huggingFaceId` field.
 */
export class TransformersJsBackend implements LocalSTTBackend {
  readonly name = "transformers.js";

  private readonly cacheDir: string;

  constructor(options: TransformersJsBackendOptions = {}) {
    this.cacheDir = options.cacheDir ?? HF_CACHE_DIR;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await import("@huggingface/transformers");
      return true;
    } catch {
      return false;
    }
  }

  /** Returns true only if the model weights are present in the HF cache. */
  isModelCached(huggingFaceId: string): boolean {
    const cacheKey = huggingFaceId.replace(/\//g, "--");
    const snapshotsDir = path.join(this.cacheDir, `models--${cacheKey}`, "snapshots");
    try {
      return fs.readdirSync(snapshotsDir).length > 0;
    } catch {
      return false;
    }
  }

  async transcribe(req: BackendTranscriptionRequest): Promise<BackendTranscriptionResponse> {
    if (req.model.kind !== "transformers-js") {
      throw new Error(
        `TransformersJsBackend requires a transformers-js model ref, got "${req.model.kind}"`,
      );
    }
    const modelId = req.model.modelId;
    const huggingFaceId = this.resolveHuggingFaceId(modelId);

    const { pipeline, env } = await import("@huggingface/transformers");

    // Point HF cache to our managed directory
    env.cacheDir = this.cacheDir;

    const pipe = await pipeline("automatic-speech-recognition", huggingFaceId, {
      dtype: "q4" as never,
    });

    const result = await (pipe as (
      input: string,
      opts: { language?: string; return_timestamps?: boolean | "word" }
    ) => Promise<{ text: string; chunks?: Array<{ timestamp: [number, number]; text: string }> }>)(
      req.audioPath,
      {
        language: req.language && req.language !== "auto" ? req.language : undefined,
        return_timestamps: req.timestamps ? "word" : false,
      }
    );

    const segments = this.parseSegments(result, req.timestamps);

    // durationMs from last segment timestamp when available; fall back to the
    // trimmed range supplied by the caller (endMs - startMs).
    const lastEnd = req.timestamps ? (segments[segments.length - 1]?.endMs ?? 0) : 0;
    const durationMs = lastEnd > 0
      ? lastEnd
      : (req.endMs !== undefined && req.startMs !== undefined ? req.endMs - req.startMs : 0);

    // detectedLanguage: only report what we actually know.
    // When auto-detection is requested we don't get the result from the pipeline.
    const detectedLanguage = req.language && req.language !== "auto"
      ? req.language
      : undefined;

    return {
      segments,
      detectedLanguage,
      durationMs,
    };
  }

  private resolveHuggingFaceId(modelId: string): string {
    const meta = getAllModels().find((m) => m.id === modelId);
    if (meta?.huggingFaceId) return meta.huggingFaceId;
    // Fall back: treat modelId itself as a HF repo id
    return modelId;
  }

  private parseSegments(
    result: { text: string; chunks?: Array<{ timestamp: [number, number]; text: string }> },
    timestamps: boolean
  ): TranscriptSegment[] {
    if (timestamps && result.chunks && result.chunks.length > 0) {
      return result.chunks.map((chunk) => ({
        startMs: Math.round((chunk.timestamp[0] ?? 0) * 1000),
        endMs: Math.round((chunk.timestamp[1] ?? chunk.timestamp[0] ?? 0) * 1000),
        text: chunk.text.trim(),
      }));
    }

    return [
      {
        startMs: 0,
        endMs: 0,
        text: result.text.trim(),
      },
    ];
  }

  getCacheDir(): string {
    return this.cacheDir;
  }
}
