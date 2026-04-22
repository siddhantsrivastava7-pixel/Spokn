import { WindowsSTTRuntimeAdapter } from "../src/adapter/WindowsSTTRuntimeAdapter";
import { WindowsModelStore } from "../src/models/WindowsModelStore";
import { ModelNotInstalledError } from "../src/errors";
import type { LocalSTTBackend, BackendTranscriptionResponse } from "../src/backend/backendTypes";
import type { RuntimeTranscriptionRequest } from "@stt/core";

function makeRequest(overrides: Partial<RuntimeTranscriptionRequest> = {}): RuntimeTranscriptionRequest {
  return {
    modelId: "whisper-turbo",
    audioPath: "C:\\tmp\\audio.wav",
    language: "en",
    timestamps: true,
    ...overrides,
  };
}

function makeMockBackend(available = true): LocalSTTBackend {
  return {
    name: "mock-backend",
    isAvailable: jest.fn().mockResolvedValue(available),
    transcribe: jest.fn().mockResolvedValue({
      segments: [{ startMs: 0, endMs: 3000, text: "Hello world", confidence: 0.92 }],
      detectedLanguage: "english",
      durationMs: 3000,
      confidence: 0.92,
    } satisfies BackendTranscriptionResponse),
  };
}

function makeMockStore(installedIds: string[] = ["whisper-turbo"]): WindowsModelStore {
  const store = new WindowsModelStore();
  jest.spyOn(store, "isInstalled").mockImplementation((id) =>
    Promise.resolve(installedIds.includes(id))
  );
  jest.spyOn(store, "listInstalledModels").mockResolvedValue(
    installedIds.map((id) => ({
      modelId: id,
      fileName: `ggml-${id}.gguf`,
      installedAt: new Date().toISOString(),
      sizeMB: 800,
    }))
  );
  jest.spyOn(store, "getModelPath").mockResolvedValue(`C:\\models\\ggml-${installedIds[0]}.gguf`);
  return store;
}

describe("WindowsSTTRuntimeAdapter", () => {
  describe("getAvailableModelIds", () => {
    it("returns ids from model store", async () => {
      const adapter = new WindowsSTTRuntimeAdapter({
        modelStore: makeMockStore(["whisper-turbo", "whisper-large-v3"]),
        backend: makeMockBackend(),
      });
      const ids = await adapter.getAvailableModelIds();
      expect(ids).toEqual(["whisper-turbo", "whisper-large-v3"]);
    });
  });

  describe("isModelInstalled", () => {
    it("delegates to model store", async () => {
      const adapter = new WindowsSTTRuntimeAdapter({
        modelStore: makeMockStore(["whisper-turbo"]),
        backend: makeMockBackend(),
      });
      expect(await adapter.isModelInstalled("whisper-turbo")).toBe(true);
      expect(await adapter.isModelInstalled("parakeet-v3")).toBe(false);
    });
  });

  describe("transcribe", () => {
    it("returns normalized response for installed model", async () => {
      const backend = makeMockBackend();
      const adapter = new WindowsSTTRuntimeAdapter({
        modelStore: makeMockStore(),
        backend,
      });

      const result = await adapter.transcribe(makeRequest());
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0]?.text).toBe("Hello world");
      expect(result.language).toBe("english");
      expect(result.durationMs).toBe(3000);
      expect(result.confidence).toBe(0.92);
    });

    it("throws ModelNotInstalledError when model is not installed", async () => {
      const adapter = new WindowsSTTRuntimeAdapter({
        modelStore: makeMockStore([]),
        backend: makeMockBackend(),
      });

      await expect(adapter.transcribe(makeRequest())).rejects.toThrow(
        ModelNotInstalledError
      );
    });

    it("passes chunk offset info to backend", async () => {
      const backend = makeMockBackend();
      const adapter = new WindowsSTTRuntimeAdapter({
        modelStore: makeMockStore(),
        backend,
      });

      await adapter.transcribe(makeRequest({ startMs: 5000, endMs: 35000 }));
      expect(backend.transcribe).toHaveBeenCalledWith(
        expect.objectContaining({ startMs: 5000, endMs: 35000 })
      );
    });

    it("wraps the resolved path as a whisper-cpp ModelRef", async () => {
      const backend = makeMockBackend();
      const adapter = new WindowsSTTRuntimeAdapter({
        modelStore: makeMockStore(),
        backend,
      });
      await adapter.transcribe(makeRequest());
      expect(backend.transcribe).toHaveBeenCalledWith(
        expect.objectContaining({
          model: {
            kind: "whisper-cpp",
            path: "C:\\models\\ggml-whisper-turbo.gguf",
          },
        })
      );
    });

    it("omits confidence from response when backend does not provide it", async () => {
      const backend: LocalSTTBackend = {
        name: "mock",
        isAvailable: jest.fn().mockResolvedValue(true),
        transcribe: jest.fn().mockResolvedValue({
          segments: [{ startMs: 0, endMs: 1000, text: "Hi" }],
          detectedLanguage: "english",
          durationMs: 1000,
          // no confidence field
        } satisfies BackendTranscriptionResponse),
      };
      const adapter = new WindowsSTTRuntimeAdapter({
        modelStore: makeMockStore(),
        backend,
      });
      const result = await adapter.transcribe(makeRequest());
      expect(result.confidence).toBeUndefined();
    });
  });
});
