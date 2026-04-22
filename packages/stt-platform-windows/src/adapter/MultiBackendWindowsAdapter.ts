import type {
  STTRuntimeAdapter,
  RuntimeTranscriptionRequest,
  RuntimeTranscriptionResponse,
} from "@stt/core";
import { getModelById } from "@stt/core";
import { WindowsModelStore } from "../models/WindowsModelStore";
import { WhisperCppBackend } from "../backend/WhisperCppBackend";
import { TransformersJsBackend } from "../backend/TransformersJsBackend";
import type { LocalSTTBackend } from "../backend/backendTypes";
import { ModelNotInstalledError } from "../errors";

export interface MultiBackendWindowsAdapterOptions {
  modelStore?: WindowsModelStore;
  whisperCppBackend?: LocalSTTBackend;
  transformersJsBackend?: TransformersJsBackend;
}

/**
 * Runtime adapter that routes inference to the correct backend based on
 * the model's `backendId` field in the stt-core registry:
 *   - "whisper-cpp"     → WhisperCppBackend (local .bin file)
 *   - "transformers-js" → TransformersJsBackend (HuggingFace ONNX, auto-downloaded)
 *
 * For transformers-js models the model store is bypassed — the HF library
 * manages its own cache in %LOCALAPPDATA%/stt-platform-windows/hf-cache/.
 * `isModelInstalled` returns true for those models as long as the HF cache
 * directory exists (the library handles its own freshness).
 */
export class MultiBackendWindowsAdapter implements STTRuntimeAdapter {
  private readonly modelStore: WindowsModelStore;
  private readonly whisperBackend: LocalSTTBackend;
  private readonly transformersBackend: TransformersJsBackend;

  constructor(options: MultiBackendWindowsAdapterOptions = {}) {
    this.modelStore = options.modelStore ?? new WindowsModelStore();
    this.whisperBackend = options.whisperCppBackend ?? new WhisperCppBackend();
    this.transformersBackend = options.transformersJsBackend ?? new TransformersJsBackend();
  }

  async getAvailableModelIds(): Promise<string[]> {
    const whisperIds = (await this.modelStore.listInstalledModels()).map((e) => e.modelId);

    // Transformers-js models are available only when their weights are cached locally.
    const transformersAvailable = await this.transformersBackend.isAvailable();
    const transformersIds = transformersAvailable
      ? this.getTransformersModelIds().filter((id) => {
          const meta = getModelById(id);
          return meta?.huggingFaceId
            ? this.transformersBackend.isModelCached(meta.huggingFaceId)
            : false;
        })
      : [];

    return [...whisperIds, ...transformersIds];
  }

  async isModelInstalled(modelId: string): Promise<boolean> {
    const meta = getModelById(modelId);
    if (meta?.backendId === "transformers-js") {
      if (!meta.huggingFaceId) return false;
      return (
        (await this.transformersBackend.isAvailable()) &&
        this.transformersBackend.isModelCached(meta.huggingFaceId)
      );
    }
    return this.modelStore.isInstalled(modelId);
  }

  async transcribe(request: RuntimeTranscriptionRequest): Promise<RuntimeTranscriptionResponse> {
    const { modelId, audioPath, language, timestamps, startMs, endMs, prompt, decodingHints } = request;
    const meta = getModelById(modelId);
    const backendId = meta?.backendId ?? "whisper-cpp";

    if (backendId === "transformers-js") {
      const backendResponse = await this.transformersBackend.transcribe({
        audioPath,
        model: { kind: "transformers-js", modelId },
        language,
        timestamps,
        startMs,
        endMs,
        prompt,
        decodingHints,
      });

      const response: RuntimeTranscriptionResponse = {
        segments: backendResponse.segments,
        language: backendResponse.detectedLanguage ?? "unknown",
        durationMs: backendResponse.durationMs,
      };
      if (backendResponse.confidence !== undefined) response.confidence = backendResponse.confidence;
      if (backendResponse.audioQuality) response.audioQuality = backendResponse.audioQuality;
      if (backendResponse.preprocessing) response.preprocessing = backendResponse.preprocessing;
      return response;
    }

    // whisper-cpp path
    const installed = await this.modelStore.isInstalled(modelId);
    if (!installed) throw new ModelNotInstalledError(modelId);

    const modelPath = await this.modelStore.getModelPath(modelId);
    const backendResponse = await this.whisperBackend.transcribe({
      audioPath,
      model: { kind: "whisper-cpp", path: modelPath },
      language,
      timestamps,
      startMs,
      endMs,
      prompt,
      decodingHints,
    });

    const response: RuntimeTranscriptionResponse = {
      segments: backendResponse.segments,
      language: backendResponse.detectedLanguage ?? "unknown",
      durationMs: backendResponse.durationMs,
    };
    if (backendResponse.confidence !== undefined) response.confidence = backendResponse.confidence;
    if (backendResponse.audioQuality) response.audioQuality = backendResponse.audioQuality;
    if (backendResponse.preprocessing) response.preprocessing = backendResponse.preprocessing;
    return response;
  }

  getModelStore(): WindowsModelStore {
    return this.modelStore;
  }

  getWhisperBackend(): LocalSTTBackend {
    return this.whisperBackend;
  }

  getTransformersBackend(): TransformersJsBackend {
    return this.transformersBackend;
  }

  private getTransformersModelIds(): string[] {
    // Lazy import of getAllModels to avoid circular deps at module load time
    const { getAllModels } = require("@stt/core") as { getAllModels: () => import("@stt/core").STTModelMetadata[] };
    return getAllModels()
      .filter((m) => m.backendId === "transformers-js")
      .map((m) => m.id);
  }
}
