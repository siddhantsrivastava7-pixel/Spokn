import { transcribeFile } from "../src/pipeline/transcribeFile";
import type {
  DeviceProfile,
  RuntimeTranscriptionRequest,
  RuntimeTranscriptionResponse,
  ScoredSegment,
  STTRuntimeAdapter,
  Transcript,
  TranscriptionInput,
  TranscriptionSettings,
} from "../src/types";

const highEndDevice: DeviceProfile = {
  platform: "macos",
  cpuTier: "high",
  ramMB: 16384,
  storageAvailableMB: 10000,
  batterySaverActive: false,
  lowPowerMode: false,
  hasNeuralEngine: true,
};

const baseSettings: TranscriptionSettings = {
  mode: "fast",
  language: "en",
  timestamps: true,
  offlineOnly: true,
};

const baseInput: TranscriptionInput = {
  audioPath: "fixture.wav",
  durationMs: 3000,
  sampleRate: 16000,
};

function makeAdapter(opts: {
  installedIds?: string[];
  response?: (req: RuntimeTranscriptionRequest) => RuntimeTranscriptionResponse;
  throwOn?: (req: RuntimeTranscriptionRequest) => boolean;
}): STTRuntimeAdapter & { calls: RuntimeTranscriptionRequest[] } {
  const calls: RuntimeTranscriptionRequest[] = [];
  const installed = opts.installedIds ?? ["whisper-turbo"];
  const defaultResponse = (
    _req: RuntimeTranscriptionRequest,
  ): RuntimeTranscriptionResponse => ({
    segments: [
      { startMs: 0, endMs: 1000, text: "Hello", confidence: 0.9 },
      { startMs: 1000, endMs: 2000, text: "world", confidence: 0.1 },
      { startMs: 2000, endMs: 3000, text: "foo", confidence: 0.4 },
    ],
    language: "en",
    durationMs: 3000,
    confidence: 0.5,
  });
  return {
    calls,
    getAvailableModelIds: async () => installed,
    isModelInstalled: async (id) => installed.includes(id),
    transcribe: async (req) => {
      calls.push(req);
      if (opts.throwOn?.(req)) throw new Error("adapter failed");
      return (opts.response ?? defaultResponse)(req);
    },
  };
}

describe("transcribeFile (foundation integration)", () => {
  test("happy path: scoring + reprocess + final transcript", async () => {
    const adapter = makeAdapter({});
    const result = await transcribeFile({
      input: baseInput,
      settings: baseSettings,
      deviceProfile: highEndDevice,
      runtimeAdapter: adapter,
      processingMode: "balanced",
    });

    const t = result.transcript;
    expect(t.isFinal).toBe(true);
    expect(t.version).toBe(3);
    expect(t.processingMode).toBe("balanced");
    expect(t.qualityTier).toBeDefined();
    expect(t.latencyMs).toBeGreaterThanOrEqual(0);
    // LOW segment at index 1 should have been reprocessed.
    const lowSeg = t.segments[1] as ScoredSegment | undefined;
    expect(lowSeg?.reprocessed).toBe(true);
  });

  test("instant mode: no reprocess", async () => {
    const adapter = makeAdapter({});
    const result = await transcribeFile({
      input: baseInput,
      settings: baseSettings,
      deviceProfile: highEndDevice,
      runtimeAdapter: adapter,
      processingMode: "instant",
    });
    // Only one adapter call: the original transcription. No reprocess runs.
    expect(adapter.calls).toHaveLength(1);
    const seg = result.transcript.segments[1] as ScoredSegment | undefined;
    expect(seg?.reprocessed).toBeUndefined();
  });

  test("long audio: forces light path, disables reprocess, records downgrade", async () => {
    const adapter = makeAdapter({});
    const result = await transcribeFile({
      input: { ...baseInput, durationMs: 10 * 60_000 },
      settings: baseSettings,
      deviceProfile: highEndDevice,
      runtimeAdapter: adapter,
      processingMode: "balanced",
      audioDurationGuardMs: 120_000,
    });
    expect(result.transcript.downgrades).toContain("long_audio_light_path");
    // No call should use highAccuracy — that flag is exclusive to reprocessing.
    expect(
      adapter.calls.filter((c) => c.decodingHints?.highAccuracy === true),
    ).toHaveLength(0);
  });

  test("partial output: v1 and v2 emitted, both non-final, same id as v3", async () => {
    const adapter = makeAdapter({});
    const partials: Transcript[] = [];
    const result = await transcribeFile({
      input: baseInput,
      settings: baseSettings,
      deviceProfile: highEndDevice,
      runtimeAdapter: adapter,
      processingMode: "balanced",
      onPartial: (p) => partials.push(p),
    });
    expect(partials).toHaveLength(2);
    expect(partials[0]?.version).toBe(1);
    expect(partials[0]?.isFinal).toBe(false);
    expect(partials[1]?.version).toBe(2);
    expect(partials[1]?.isFinal).toBe(false);
    expect(result.transcript.isFinal).toBe(true);
  });

  test("hard fallback: adapter throws on primary and no fallback model", async () => {
    const adapter = makeAdapter({
      installedIds: ["whisper-turbo"],
      throwOn: () => true,
    });
    const result = await transcribeFile({
      input: baseInput,
      settings: baseSettings,
      deviceProfile: highEndDevice,
      runtimeAdapter: adapter,
    });
    expect(result.transcript.fallbackUsed).toBe(true);
    expect(result.transcript.fallbackStage).toBe("transcribe");
    expect(result.transcript.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("onPartial errors don't break the pipeline", async () => {
    const adapter = makeAdapter({});
    const result = await transcribeFile({
      input: baseInput,
      settings: baseSettings,
      deviceProfile: highEndDevice,
      runtimeAdapter: adapter,
      processingMode: "balanced",
      onPartial: () => {
        throw new Error("ui crashed");
      },
    });
    expect(result.transcript.isFinal).toBe(true);
    expect(result.transcript.fallbackUsed).toBeUndefined();
  });

  test("invariant: never throws — even with a broken adapter", async () => {
    const brokenAdapter: STTRuntimeAdapter = {
      getAvailableModelIds: async () => {
        throw new Error("model list failed");
      },
      isModelInstalled: async () => false,
      transcribe: async () => {
        throw new Error("transcribe failed");
      },
    };
    await expect(
      transcribeFile({
        input: baseInput,
        settings: baseSettings,
        deviceProfile: highEndDevice,
        runtimeAdapter: brokenAdapter,
      }),
    ).resolves.toBeDefined();
  });
});
