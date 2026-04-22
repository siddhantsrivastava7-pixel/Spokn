import type { AudioQualityMetrics } from "@stt/core";
import { AdaptiveBackend } from "../src/backend/AdaptiveBackend";
import type {
  BackendTranscriptionRequest,
  BackendTranscriptionResponse,
  LocalSTTBackend,
} from "../src/backend/backendTypes";
import type { PreprocessResult } from "../src/preprocessing/AdaptivePreprocessor";

function fakeInnerBackend(opts: {
  responseByPath?: Record<string, Partial<BackendTranscriptionResponse>>;
  defaultConfidence?: number;
}): LocalSTTBackend & { calls: BackendTranscriptionRequest[] } {
  const calls: BackendTranscriptionRequest[] = [];
  return {
    calls,
    name: "fake",
    isAvailable: async () => true,
    transcribe: async (req: BackendTranscriptionRequest) => {
      calls.push(req);
      const override = opts.responseByPath?.[req.audioPath] ?? {};
      return {
        segments: [
          {
            startMs: 0,
            endMs: 1000,
            text: override.segments?.[0]?.text ?? "hello world",
          },
        ],
        detectedLanguage: "en",
        durationMs: 1000,
        confidence: override.confidence ?? opts.defaultConfidence ?? 0.9,
        ...override,
      };
    },
  };
}

const cleanMetrics: AudioQualityMetrics = {
  rmsDb: -18,
  peakDb: -3,
  clippingRatio: 0,
  silenceRatio: 0.1,
  estimatedNoiseFloorDb: -60,
  needsPreprocessing: false,
  reasons: [],
};

const poorMetrics: AudioQualityMetrics = {
  rmsDb: -40,
  peakDb: -20,
  clippingRatio: 0,
  silenceRatio: 0.1,
  estimatedNoiseFloorDb: -55,
  needsPreprocessing: true,
  reasons: ["rms_too_low:-40.0dB"],
};

function makePrep(cleanedPath: string): PreprocessResult {
  return {
    cleanedPath,
    stages: ["mono", "resample:16000", "normalize", "trim_silence"],
    cleanup: async () => {},
  };
}

describe("AdaptiveBackend", () => {
  test("pass-through when ffmpeg is unavailable", async () => {
    const inner = fakeInnerBackend({});
    const backend = new AdaptiveBackend(inner, {
      mode: "adaptive",
      _resolveFfmpegPath: async () => undefined,
    });
    const res = await backend.transcribe({
      audioPath: "raw.wav",
      model: { kind: "whisper-cpp", path: "m.gguf" },
      timestamps: true,
    });
    expect(inner.calls.map((c) => c.audioPath)).toEqual(["raw.wav"]);
    expect(res.preprocessing?.applied).toBe(false);
    expect(res.preprocessing?.reason).toBe("mode_disabled");
  });

  test('pass-through when mode="never" even with ffmpeg present', async () => {
    const inner = fakeInnerBackend({});
    const backend = new AdaptiveBackend(inner, {
      mode: "never",
      _resolveFfmpegPath: async () => "ffmpeg",
    });
    const res = await backend.transcribe({
      audioPath: "raw.wav",
      model: { kind: "whisper-cpp", path: "m.gguf" },
      timestamps: true,
    });
    expect(inner.calls).toHaveLength(1);
    expect(res.preprocessing?.applied).toBe(false);
  });

  test("adaptive + clean audio: transcribe raw, skipped_clean_audio reason", async () => {
    const inner = fakeInnerBackend({ defaultConfidence: 0.9 });
    const backend = new AdaptiveBackend(inner, {
      mode: "adaptive",
      _resolveFfmpegPath: async () => "ffmpeg",
      _analyzeAudio: async () => cleanMetrics,
    });
    const res = await backend.transcribe({
      audioPath: "raw.wav",
      model: { kind: "whisper-cpp", path: "m.gguf" },
      timestamps: true,
    });
    expect(inner.calls.map((c) => c.audioPath)).toEqual(["raw.wav"]);
    expect(res.preprocessing?.applied).toBe(false);
    expect(res.preprocessing?.reason).toBe("skipped_clean_audio");
    expect(res.audioQuality?.needsPreprocessing).toBe(false);
  });

  test("adaptive + poor audio: preprocess upfront", async () => {
    const inner = fakeInnerBackend({});
    const backend = new AdaptiveBackend(inner, {
      mode: "adaptive",
      _resolveFfmpegPath: async () => "ffmpeg",
      _analyzeAudio: async () => poorMetrics,
      _preprocessAudio: async () => makePrep("cleaned.wav"),
    });
    const res = await backend.transcribe({
      audioPath: "raw.wav",
      model: { kind: "whisper-cpp", path: "m.gguf" },
      timestamps: true,
    });
    expect(inner.calls.map((c) => c.audioPath)).toEqual(["cleaned.wav"]);
    expect(res.preprocessing?.applied).toBe(true);
    expect(res.preprocessing?.reason).toBe("poor_quality");
    expect(res.preprocessing?.stages).toContain("normalize");
  });

  test("adaptive + clean audio but LOW confidence: retry with preprocessing, take higher confidence", async () => {
    const inner = fakeInnerBackend({
      responseByPath: {
        "raw.wav": { confidence: 0.3 }, // first call low
        "cleaned.wav": { confidence: 0.85 }, // retry high
      },
    });
    const backend = new AdaptiveBackend(inner, {
      mode: "adaptive",
      _resolveFfmpegPath: async () => "ffmpeg",
      _analyzeAudio: async () => cleanMetrics,
      _preprocessAudio: async () => makePrep("cleaned.wav"),
    });
    const res = await backend.transcribe({
      audioPath: "raw.wav",
      model: { kind: "whisper-cpp", path: "m.gguf" },
      timestamps: true,
    });
    expect(inner.calls.map((c) => c.audioPath)).toEqual([
      "raw.wav",
      "cleaned.wav",
    ]);
    expect(res.preprocessing?.reason).toBe("low_confidence_retry");
    expect(res.confidence).toBeCloseTo(0.85);
  });

  test("adaptive + LOW confidence retry worse than raw: keep raw", async () => {
    const inner = fakeInnerBackend({
      responseByPath: {
        "raw.wav": { confidence: 0.5 },
        "cleaned.wav": { confidence: 0.3 },
      },
    });
    const backend = new AdaptiveBackend(inner, {
      mode: "adaptive",
      _resolveFfmpegPath: async () => "ffmpeg",
      _analyzeAudio: async () => cleanMetrics,
      _preprocessAudio: async () => makePrep("cleaned.wav"),
      confidenceRetryThreshold: 0.55,
    });
    const res = await backend.transcribe({
      audioPath: "raw.wav",
      model: { kind: "whisper-cpp", path: "m.gguf" },
      timestamps: true,
    });
    // Both calls happened...
    expect(inner.calls).toHaveLength(2);
    // ...but the result came from the raw path.
    expect(res.confidence).toBe(0.5);
    expect(res.preprocessing?.applied).toBe(false);
  });

  test('mode="always" preprocesses every request', async () => {
    const inner = fakeInnerBackend({});
    const backend = new AdaptiveBackend(inner, {
      mode: "always",
      _resolveFfmpegPath: async () => "ffmpeg",
      _preprocessAudio: async () => makePrep("cleaned.wav"),
    });
    const res = await backend.transcribe({
      audioPath: "raw.wav",
      model: { kind: "whisper-cpp", path: "m.gguf" },
      timestamps: true,
    });
    expect(inner.calls[0]?.audioPath).toBe("cleaned.wav");
    expect(res.preprocessing?.applied).toBe(true);
  });

  test("slice requests bypass preprocessing (chunk-safe)", async () => {
    const inner = fakeInnerBackend({});
    const backend = new AdaptiveBackend(inner, {
      mode: "always",
      _resolveFfmpegPath: async () => "ffmpeg",
      _preprocessAudio: async () => makePrep("cleaned.wav"),
    });
    await backend.transcribe({
      audioPath: "raw.wav",
      model: { kind: "whisper-cpp", path: "m.gguf" },
      timestamps: true,
      startMs: 1000,
      endMs: 2000,
    });
    expect(inner.calls[0]?.audioPath).toBe("raw.wav");
  });

  test("preprocessing failure falls back to raw transcription (never throws)", async () => {
    const inner = fakeInnerBackend({ defaultConfidence: 0.4 });
    const backend = new AdaptiveBackend(inner, {
      mode: "adaptive",
      _resolveFfmpegPath: async () => "ffmpeg",
      _analyzeAudio: async () => poorMetrics,
      _preprocessAudio: async () => {
        throw new Error("ffmpeg exploded");
      },
    });
    const res = await backend.transcribe({
      audioPath: "raw.wav",
      model: { kind: "whisper-cpp", path: "m.gguf" },
      timestamps: true,
    });
    // Pipeline continued — raw was used.
    expect(inner.calls[0]?.audioPath).toBe("raw.wav");
    expect(res.preprocessing?.applied).toBe(false);
  });

  test("quality probe failure falls back gracefully", async () => {
    const inner = fakeInnerBackend({});
    const backend = new AdaptiveBackend(inner, {
      mode: "adaptive",
      _resolveFfmpegPath: async () => "ffmpeg",
      _analyzeAudio: async () => {
        throw new Error("probe failed");
      },
    });
    const res = await backend.transcribe({
      audioPath: "raw.wav",
      model: { kind: "whisper-cpp", path: "m.gguf" },
      timestamps: true,
    });
    expect(res.preprocessing?.reason).toBe("mode_disabled");
  });
});
