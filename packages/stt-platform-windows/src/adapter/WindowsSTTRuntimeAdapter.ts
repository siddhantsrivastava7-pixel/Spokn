import type {
  STTRuntimeAdapter,
  RuntimeTranscriptionRequest,
  RuntimeTranscriptionResponse,
} from "@stt/core";
import { WindowsModelStore } from "../models/WindowsModelStore";
import { WhisperCppBackend } from "../backend/WhisperCppBackend";
import type { LocalSTTBackend } from "../backend/backendTypes";
import { ModelNotInstalledError } from "../errors";
import type { WindowsSTTRuntimeAdapterOptions } from "./runtimeTypes";

/**
 * Windows runtime adapter for stt-core.
 *
 * Implements STTRuntimeAdapter by:
 *   1. Managing local model files via WindowsModelStore
 *   2. Delegating actual inference to a LocalSTTBackend (default: WhisperCppBackend)
 *
 * The backend is swappable — pass a different LocalSTTBackend to the constructor
 * to replace whisper.cpp without changing this class.
 */
export class WindowsSTTRuntimeAdapter implements STTRuntimeAdapter {
  private readonly modelStore: WindowsModelStore;
  private readonly backend: LocalSTTBackend;

  constructor(options: WindowsSTTRuntimeAdapterOptions = {}) {
    this.modelStore = options.modelStore ?? new WindowsModelStore();
    this.backend = options.backend ?? new WhisperCppBackend();
  }

  async getAvailableModelIds(): Promise<string[]> {
    const entries = await this.modelStore.listInstalledModels();
    return entries.map((e) => e.modelId);
  }

  async isModelInstalled(modelId: string): Promise<boolean> {
    return this.modelStore.isInstalled(modelId);
  }

  async transcribe(
    request: RuntimeTranscriptionRequest
  ): Promise<RuntimeTranscriptionResponse> {
    const {
      modelId,
      audioPath,
      language,
      timestamps,
      startMs,
      endMs,
      prompt,
      decodingHints,
    } = request;

    const installed = await this.modelStore.isInstalled(modelId);
    if (!installed) {
      throw new ModelNotInstalledError(modelId);
    }

    const modelPath = await this.modelStore.getModelPath(modelId);

    const backendResponse = await this.backend.transcribe({
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

    if (backendResponse.confidence !== undefined) {
      response.confidence = backendResponse.confidence;
    }
    if (backendResponse.audioQuality) {
      response.audioQuality = backendResponse.audioQuality;
    }
    if (backendResponse.preprocessing) {
      response.preprocessing = backendResponse.preprocessing;
    }

    return response;
  }

  /** Exposes the model store for external management (install/uninstall workflows). */
  getModelStore(): WindowsModelStore {
    return this.modelStore;
  }

  /** Exposes the backend for diagnostics or testing. */
  getBackend(): LocalSTTBackend {
    return this.backend;
  }
}
