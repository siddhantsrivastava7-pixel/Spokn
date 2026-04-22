import {
  normalizedLevenshtein,
  selectiveReprocess,
} from "../src/pipeline/selectiveReprocess";
import { LatencyBudget } from "../src/pipeline/latencyBudget";
import type {
  RuntimeTranscriptionRequest,
  RuntimeTranscriptionResponse,
  ScoredSegment,
  STTRuntimeAdapter,
} from "../src/types";

function scored(
  text: string,
  tier: ScoredSegment["tier"],
  startMs = 0,
  endMs = 1000,
  confidence?: number,
): ScoredSegment {
  const base: ScoredSegment = { startMs, endMs, text, tier };
  if (confidence !== undefined) base.confidence = confidence;
  return base;
}

interface FakeAdapterOpts {
  installedIds?: string[];
  responder?: (req: RuntimeTranscriptionRequest) => RuntimeTranscriptionResponse;
  throwOn?: (req: RuntimeTranscriptionRequest) => boolean;
}

function fakeAdapter(opts: FakeAdapterOpts = {}): STTRuntimeAdapter & {
  calls: RuntimeTranscriptionRequest[];
} {
  const calls: RuntimeTranscriptionRequest[] = [];
  const installed = opts.installedIds ?? [];
  const defaultResponder = (req: RuntimeTranscriptionRequest): RuntimeTranscriptionResponse => ({
    segments: [
      {
        startMs: req.startMs ?? 0,
        endMs: req.endMs ?? 1000,
        text: "reprocessed",
        confidence: 0.85,
      },
    ],
    language: "en",
    durationMs: (req.endMs ?? 1000) - (req.startMs ?? 0),
  });
  return {
    calls,
    getAvailableModelIds: async () => installed,
    isModelInstalled: async (id) => installed.includes(id),
    transcribe: async (req) => {
      calls.push(req);
      if (opts.throwOn?.(req)) {
        throw new Error("boom");
      }
      return (opts.responder ?? defaultResponder)(req);
    },
  };
}

describe("normalizedLevenshtein", () => {
  test("identical strings → 0", () => {
    expect(normalizedLevenshtein("a b c", "a b c")).toBe(0);
  });
  test("completely different → 1", () => {
    expect(normalizedLevenshtein("a b c", "x y z")).toBe(1);
  });
  test("partial overlap is fractional", () => {
    expect(normalizedLevenshtein("a b c", "a b d")).toBeCloseTo(1 / 3, 3);
  });
});

describe("selectiveReprocess", () => {
  test("no LOW segments → no-op", async () => {
    const adapter = fakeAdapter();
    const segments = [scored("hi", "HIGH"), scored("ok", "MEDIUM")];
    const result = await selectiveReprocess(segments, {
      runtimeAdapter: adapter,
      audioPath: "x.wav",
      language: "en",
      timestamps: true,
      primaryModelId: "whisper-turbo",
    });
    expect(result.reprocessedCount).toBe(0);
    expect(adapter.calls).toHaveLength(0);
  });

  test("reprocesses LOW segments with highAccuracy hint, caps at 3", async () => {
    const adapter = fakeAdapter();
    const segments = [
      scored("a", "LOW", 0, 500, 0.05),
      scored("b", "LOW", 500, 1000, 0.1),
      scored("c", "LOW", 1000, 1500, 0.15),
      scored("d", "LOW", 1500, 2000, 0.2),
      scored("e", "LOW", 2000, 2500, 0.25),
    ];
    const result = await selectiveReprocess(segments, {
      runtimeAdapter: adapter,
      audioPath: "x.wav",
      language: "en",
      timestamps: true,
      primaryModelId: "whisper-turbo",
    });
    expect(result.reprocessedCount).toBe(3);
    expect(result.downgrades).toContain("reprocess_cap_hit");
    for (const call of adapter.calls) {
      expect(call.decodingHints).toEqual({ highAccuracy: true });
      expect(call.modelId).toBe("whisper-turbo");
    }
  });

  test("uses pickEscalationModel when given and installed", async () => {
    const adapter = fakeAdapter({ installedIds: ["whisper-turbo", "whisper-large-v3"] });
    const segments = [scored("a", "LOW", 0, 500, 0.05)];
    const result = await selectiveReprocess(segments, {
      runtimeAdapter: adapter,
      audioPath: "x.wav",
      language: "en",
      timestamps: true,
      primaryModelId: "whisper-turbo",
      pickEscalationModel: (installed) =>
        installed.includes("whisper-large-v3") ? "whisper-large-v3" : undefined,
    });
    expect(result.escalationModelId).toBe("whisper-large-v3");
    expect(adapter.calls[0]?.modelId).toBe("whisper-large-v3");
  });

  test("individual reprocess errors don't poison other segments", async () => {
    const adapter = fakeAdapter({
      throwOn: (req) => req.startMs === 500,
    });
    const segments = [
      scored("a", "LOW", 0, 500, 0.1),
      scored("b", "LOW", 500, 1000, 0.1),
      scored("c", "LOW", 1000, 1500, 0.1),
    ];
    const result = await selectiveReprocess(segments, {
      runtimeAdapter: adapter,
      audioPath: "x.wav",
      language: "en",
      timestamps: true,
      primaryModelId: "whisper-turbo",
    });
    expect(result.reprocessedCount).toBe(2);
    expect(result.downgrades.some((d) => d.startsWith("reprocess_error:"))).toBe(
      true,
    );
    expect(result.segments[1]?.text).toBe("b");
    expect(result.segments[1]?.reprocessed).toBeUndefined();
  });

  test("budget-gated: skips remaining when budget is exhausted", async () => {
    const budget = new LatencyBudget(10);
    await new Promise((r) => setTimeout(r, 30));
    const adapter = fakeAdapter();
    const segments = [
      scored("a", "LOW", 0, 500, 0.1),
      scored("b", "LOW", 500, 1000, 0.1),
    ];
    const result = await selectiveReprocess(segments, {
      runtimeAdapter: adapter,
      audioPath: "x.wav",
      language: "en",
      timestamps: true,
      primaryModelId: "whisper-turbo",
      budget,
      perSegmentEstimateMs: 500,
    });
    expect(result.reprocessedCount).toBe(0);
    expect(result.downgrades).toContain("skipped_reprocess_for_budget");
  });

  test("keeps original text when reprocessed text is too similar", async () => {
    const adapter = fakeAdapter({
      responder: (req) => ({
        segments: [
          {
            startMs: req.startMs ?? 0,
            endMs: req.endMs ?? 1000,
            text: "hello world", // identical to original
            confidence: 0.9,
          },
        ],
        language: "en",
        durationMs: 1000,
      }),
    });
    const segments = [scored("hello world", "LOW", 0, 1000, 0.1)];
    const result = await selectiveReprocess(segments, {
      runtimeAdapter: adapter,
      audioPath: "x.wav",
      language: "en",
      timestamps: true,
      primaryModelId: "whisper-turbo",
    });
    expect(result.segments[0]?.text).toBe("hello world");
    expect(result.segments[0]?.reprocessed).toBe(true);
    expect(result.segments[0]?.originalText).toBe("hello world");
  });
});
