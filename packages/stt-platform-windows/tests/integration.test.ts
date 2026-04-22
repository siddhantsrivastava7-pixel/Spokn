/**
 * Integration harness: demonstrates transcribeFile() from stt-core
 * calling through WindowsSTTRuntimeAdapter → mock backend.
 *
 * This test uses a real stt-core pipeline invocation with a mocked
 * adapter so it verifies the contract between core and the Windows
 * adapter without requiring whisper-cli.exe to be installed.
 */
import { transcribeFile } from "@stt/core";
import { WindowsSTTRuntimeAdapter } from "../src/adapter/WindowsSTTRuntimeAdapter";
import { WindowsModelStore } from "../src/models/WindowsModelStore";
import type { LocalSTTBackend, BackendTranscriptionResponse } from "../src/backend/backendTypes";
import type { DeviceProfile } from "@stt/core";

const DEVICE_PROFILE: DeviceProfile = {
  platform: "windows",
  cpuTier: "high",
  ramMB: 16384,
  storageAvailableMB: 50000,
  batterySaverActive: false,
  lowPowerMode: false,
  osVersion: "10.0.22631",
};

function makeMockBackend(): LocalSTTBackend {
  return {
    name: "mock-whisper",
    isAvailable: jest.fn().mockResolvedValue(true),
    transcribe: jest.fn().mockResolvedValue({
      segments: [
        { startMs: 0, endMs: 2400, text: "Namaste, how are you?", confidence: 0.93 },
        { startMs: 2400, endMs: 5100, text: "Main theek hoon.", confidence: 0.89 },
      ],
      detectedLanguage: "hindi",
      durationMs: 5100,
      confidence: 0.91,
    } satisfies BackendTranscriptionResponse),
  };
}

function makeMockStore(): WindowsModelStore {
  const store = new WindowsModelStore();
  jest.spyOn(store, "isInstalled").mockResolvedValue(true);
  jest.spyOn(store, "listInstalledModels").mockResolvedValue([
    {
      modelId: "whisper-turbo",
      fileName: "ggml-whisper-turbo.gguf",
      installedAt: new Date().toISOString(),
      sizeMB: 809,
      displayName: "Whisper Turbo",
    },
  ]);
  jest.spyOn(store, "getModelPath").mockResolvedValue(
    "C:\\models\\ggml-whisper-turbo.gguf"
  );
  return store;
}

describe("transcribeFile integration (stt-core → stt-platform-windows)", () => {
  it("completes a full pipeline run for a Hinglish audio file", async () => {
    const runtimeAdapter = new WindowsSTTRuntimeAdapter({
      modelStore: makeMockStore(),
      backend: makeMockBackend(),
    });

    const result = await transcribeFile({
      input: {
        audioPath: "C:/temp/sample_hinglish.wav",
        durationMs: 5100,
      },
      settings: {
        mode: "auto",
        language: "hinglish",
        timestamps: true,
        offlineOnly: true,
      },
      deviceProfile: DEVICE_PROFILE,
      runtimeAdapter,
      userSpeechProfile: {
        countryCode: "IN",
        primaryLanguages: ["en", "hi"],
        mixesLanguages: true,
      },
    });

    expect(result).toBeDefined();
    expect(result.transcript).toBeDefined();
    expect(result.transcript.fullText.length).toBeGreaterThan(0);
    expect(result.transcript.segments.length).toBeGreaterThan(0);
    expect(result.transcript.modelId).toBeTruthy();
  });

  it("returns a transcript with the correct segment structure", async () => {
    const runtimeAdapter = new WindowsSTTRuntimeAdapter({
      modelStore: makeMockStore(),
      backend: makeMockBackend(),
    });

    const result = await transcribeFile({
      input: { audioPath: "C:/temp/sample.wav", durationMs: 5100 },
      settings: { mode: "fast", language: "en", timestamps: true, offlineOnly: true },
      deviceProfile: DEVICE_PROFILE,
      runtimeAdapter,
    });

    const segments = result.transcript.segments;
    expect(Array.isArray(segments)).toBe(true);
    for (const seg of segments) {
      expect(typeof seg.startMs).toBe("number");
      expect(typeof seg.endMs).toBe("number");
      expect(typeof seg.text).toBe("string");
    }
  });
});
