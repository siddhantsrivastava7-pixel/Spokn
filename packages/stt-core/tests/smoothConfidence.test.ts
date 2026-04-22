import {
  scoreSegments,
  smoothConfidence,
} from "../src/analysis/segmentConfidence";
import type { ScoredSegment, TranscriptSegment } from "../src/types";

function scored(overrides: Partial<ScoredSegment> & { startMs: number; endMs: number; text: string }): ScoredSegment {
  return {
    tier: "HIGH",
    ...overrides,
  } as ScoredSegment;
}

describe("smoothConfidence", () => {
  test("empty input returns empty array", () => {
    expect(smoothConfidence([])).toEqual([]);
  });

  test("single segment — smoothed equals its own normalized value", () => {
    const [out] = smoothConfidence([
      scored({ startMs: 0, endMs: 1000, text: "a", normalizedConfidence: 0.8 }),
    ]);
    expect(out?.smoothedConfidence).toBeCloseTo(0.8);
  });

  test("middle segment uses 0.6/0.2/0.2 weighting", () => {
    const smoothed = smoothConfidence([
      scored({ startMs: 0, endMs: 1000, text: "a", normalizedConfidence: 0.9 }),
      scored({ startMs: 1000, endMs: 2000, text: "b", normalizedConfidence: 0.3 }),
      scored({ startMs: 2000, endMs: 3000, text: "c", normalizedConfidence: 0.8 }),
    ]);
    // 0.6 * 0.3 + 0.2 * 0.9 + 0.2 * 0.8 = 0.18 + 0.18 + 0.16 = 0.52
    expect(smoothed[1]?.smoothedConfidence).toBeCloseTo(0.52);
  });

  test("first segment uses itself as previous neighbor", () => {
    const smoothed = smoothConfidence([
      scored({ startMs: 0, endMs: 1000, text: "a", normalizedConfidence: 0.9 }),
      scored({ startMs: 1000, endMs: 2000, text: "b", normalizedConfidence: 0.3 }),
    ]);
    // 0.6 * 0.9 + 0.2 * 0.9 + 0.2 * 0.3 = 0.54 + 0.18 + 0.06 = 0.78
    expect(smoothed[0]?.smoothedConfidence).toBeCloseTo(0.78);
  });

  test("last segment uses itself as next neighbor", () => {
    const smoothed = smoothConfidence([
      scored({ startMs: 0, endMs: 1000, text: "a", normalizedConfidence: 0.9 }),
      scored({ startMs: 1000, endMs: 2000, text: "b", normalizedConfidence: 0.3 }),
    ]);
    // 0.6 * 0.3 + 0.2 * 0.9 + 0.2 * 0.3 = 0.18 + 0.18 + 0.06 = 0.42
    expect(smoothed[1]?.smoothedConfidence).toBeCloseTo(0.42);
  });

  test("does not mutate normalizedConfidence", () => {
    const input: ScoredSegment[] = [
      scored({ startMs: 0, endMs: 1000, text: "a", normalizedConfidence: 0.9 }),
      scored({ startMs: 1000, endMs: 2000, text: "b", normalizedConfidence: 0.3 }),
    ];
    const out = smoothConfidence(input);
    expect(out[0]?.normalizedConfidence).toBeCloseTo(0.9);
    expect(out[1]?.normalizedConfidence).toBeCloseTo(0.3);
    // Inputs themselves must not be mutated.
    expect(input[0]?.smoothedConfidence).toBeUndefined();
    expect(input[1]?.smoothedConfidence).toBeUndefined();
  });

  test("falls back through the confidence chain when normalizedConfidence missing", () => {
    const out = smoothConfidence([
      scored({ startMs: 0, endMs: 1000, text: "a", confidence: 0.7 }),
      scored({ startMs: 1000, endMs: 2000, text: "b" }), // no signals → baseline 0.6
    ]);
    // 0.6 * 0.7 + 0.2 * 0.7 + 0.2 * 0.6 = 0.42 + 0.14 + 0.12 = 0.68
    expect(out[0]?.smoothedConfidence).toBeCloseTo(0.68);
  });

  test("scoreSegments attaches smoothedConfidence to every segment", () => {
    const input: TranscriptSegment[] = [
      { startMs: 0, endMs: 1000, text: "a", confidence: 0.9 },
      { startMs: 1000, endMs: 2000, text: "b", confidence: 0.2 },
      { startMs: 2000, endMs: 3000, text: "c", confidence: 0.7 },
    ];
    const { segments } = scoreSegments(input, "whisper");
    for (const s of segments) {
      expect(typeof s.smoothedConfidence).toBe("number");
    }
    // Middle should be closer to the neighbors' average than its own (0.2).
    expect(segments[1]?.smoothedConfidence).toBeGreaterThan(0.2);
  });
});
