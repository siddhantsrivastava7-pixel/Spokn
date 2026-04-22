import { selectiveReprocess } from "../src/pipeline/selectiveReprocess";
import type { ScoredSegment, STTRuntimeAdapter } from "../src/types";

function mkScored(overrides: Partial<ScoredSegment>): ScoredSegment {
  return {
    startMs: 0,
    endMs: 1000,
    text: "hello",
    tier: "LOW",
    ...overrides,
  } as ScoredSegment;
}

function mkAdapter(): STTRuntimeAdapter & {
  calls: number;
} {
  const adapter = {
    calls: 0,
    async getAvailableModelIds() {
      return ["m1"];
    },
    async isModelInstalled() {
      return true;
    },
    async transcribe() {
      adapter.calls++;
      return {
        segments: [{ startMs: 0, endMs: 1000, text: "better", confidence: 0.9 }],
        language: "en",
        durationMs: 1000,
      };
    },
  };
  return adapter;
}

describe("selectiveReprocess — segment-length filter", () => {
  test("skips LOW segments below minSegmentDurationMs", async () => {
    const segments: ScoredSegment[] = [
      mkScored({ startMs: 0, endMs: 100, text: "tiny", confidence: 0.1 }),     // 100ms — too short
      mkScored({ startMs: 200, endMs: 1000, text: "normal", confidence: 0.1 }), // 800ms — reprocessable
    ];
    const adapter = mkAdapter();
    const res = await selectiveReprocess(segments, {
      runtimeAdapter: adapter,
      audioPath: "a.wav",
      language: "en",
      timestamps: false,
      primaryModelId: "m1",
      minSegmentDurationMs: 400,
    });
    expect(adapter.calls).toBe(1);
    expect(res.reprocessedCount).toBe(1);
    expect(res.downgrades.some((d) => d.startsWith("skipped_short_segments:"))).toBe(true);
  });

  test("uses normalizedConfidence for ordering when present (worst first)", async () => {
    const segments: ScoredSegment[] = [
      mkScored({
        startMs: 0,
        endMs: 1000,
        text: "a",
        confidence: 0.25,
        normalizedConfidence: 0.32,
        confidenceLevel: "LOW",
      }),
      mkScored({
        startMs: 1000,
        endMs: 2000,
        text: "b",
        confidence: 0.25,
        normalizedConfidence: 0.10,
        confidenceLevel: "LOW",
      }),
      mkScored({
        startMs: 2000,
        endMs: 3000,
        text: "c",
        confidence: 0.25,
        normalizedConfidence: 0.20,
        confidenceLevel: "LOW",
      }),
    ];

    const order: number[] = [];
    const adapter: STTRuntimeAdapter = {
      async getAvailableModelIds() {
        return [];
      },
      async isModelInstalled() {
        return true;
      },
      async transcribe(req) {
        order.push(req.startMs ?? -1);
        return {
          segments: [{ startMs: 0, endMs: 100, text: "x", confidence: 0.9 }],
          language: "en",
          durationMs: 100,
        };
      },
    };

    await selectiveReprocess(segments, {
      runtimeAdapter: adapter,
      audioPath: "a.wav",
      language: "en",
      timestamps: false,
      primaryModelId: "m1",
      concurrency: 1,
      maxSegmentsToReprocess: 3,
    });

    expect(order[0]).toBe(1000); // normalizedConfidence=0.10 comes first
    expect(order[1]).toBe(2000); // normalizedConfidence=0.20
    expect(order[2]).toBe(0);    // normalizedConfidence=0.32
  });

  test("prefers smoothedConfidence over normalizedConfidence for ordering", async () => {
    // Segment B has the lowest smoothed value → must reprocess first.
    // Without smoothedConfidence preference the order would follow
    // normalizedConfidence and process A first.
    const segments: ScoredSegment[] = [
      mkScored({
        startMs: 0,
        endMs: 1000,
        text: "a",
        confidence: 0.3,
        normalizedConfidence: 0.05,
        smoothedConfidence: 0.35,
        confidenceLevel: "LOW",
      }),
      mkScored({
        startMs: 1000,
        endMs: 2000,
        text: "b",
        confidence: 0.3,
        normalizedConfidence: 0.35,
        smoothedConfidence: 0.10,
        confidenceLevel: "LOW",
      }),
    ];
    const order: number[] = [];
    const adapter = {
      async getAvailableModelIds() {
        return [];
      },
      async isModelInstalled() {
        return true;
      },
      async transcribe(req: { startMs?: number }) {
        order.push(req.startMs ?? -1);
        return {
          segments: [{ startMs: 0, endMs: 100, text: "x", confidence: 0.9 }],
          language: "en",
          durationMs: 100,
        };
      },
    };
    await selectiveReprocess(segments, {
      runtimeAdapter: adapter as STTRuntimeAdapter,
      audioPath: "a.wav",
      language: "en",
      timestamps: false,
      primaryModelId: "m1",
      concurrency: 1,
    });
    // B (startMs=1000) has smoothedConfidence=0.10 → must be first.
    expect(order[0]).toBe(1000);
    expect(order[1]).toBe(0);
  });

  test("respects confidenceLevel===LOW even when legacy tier is not LOW", async () => {
    const segments: ScoredSegment[] = [
      mkScored({
        startMs: 0,
        endMs: 1000,
        text: "a",
        confidence: 0.5,
        tier: "MEDIUM",
        normalizedConfidence: 0.2,
        confidenceLevel: "LOW",
      }),
    ];
    const adapter = mkAdapter();
    const res = await selectiveReprocess(segments, {
      runtimeAdapter: adapter,
      audioPath: "a.wav",
      language: "en",
      timestamps: false,
      primaryModelId: "m1",
    });
    expect(res.reprocessedCount).toBe(1);
  });
});
