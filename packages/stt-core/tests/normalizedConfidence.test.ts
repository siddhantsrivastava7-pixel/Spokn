import {
  NORMALIZED_CONFIDENCE_NONE_BASELINE,
  NORMALIZED_CONFIDENCE_THRESHOLDS,
  confidenceLevelFor,
  normalizeSegmentConfidence,
  scoreSegments,
} from "../src/analysis/segmentConfidence";
import type { TranscriptSegment } from "../src/types";

const seg = (overrides: Partial<TranscriptSegment>): TranscriptSegment => ({
  startMs: 0,
  endMs: 1000,
  text: "hello",
  ...overrides,
});

describe("normalizeSegmentConfidence", () => {
  test('returns the MEDIUM baseline when the model declares scale "none"', () => {
    const s = seg({ confidence: 0.95 });
    const n = normalizeSegmentConfidence(s, { confidenceScale: "none" });
    expect(n).toBe(NORMALIZED_CONFIDENCE_NONE_BASELINE);
    expect(confidenceLevelFor(n)).toBe("MEDIUM");
  });

  test("falls back to baseline when no signals are present", () => {
    const n = normalizeSegmentConfidence(seg({}));
    expect(n).toBe(NORMALIZED_CONFIDENCE_NONE_BASELINE);
  });

  test("passes through an existing confidence value when no detailed signals", () => {
    const n = normalizeSegmentConfidence(seg({ confidence: 0.9 }));
    expect(n).toBeCloseTo(0.9);
    expect(confidenceLevelFor(n)).toBe("HIGH");
  });

  test("clamps a passthrough confidence into [0, 1]", () => {
    expect(normalizeSegmentConfidence(seg({ confidence: 1.5 }))).toBe(1);
    expect(normalizeSegmentConfidence(seg({ confidence: -0.2 }))).toBe(0);
  });

  test("combines Whisper signals into a composite score", () => {
    const strong = normalizeSegmentConfidence(
      seg({ avgLogprob: 0, noSpeechProb: 0.05, compressionRatio: 1.5 }),
    );
    const weak = normalizeSegmentConfidence(
      seg({ avgLogprob: -2, noSpeechProb: 0.8, compressionRatio: 4.0 }),
    );
    expect(strong).toBeGreaterThan(weak);
    expect(strong).toBeLessThanOrEqual(1);
    expect(weak).toBeGreaterThanOrEqual(0);
  });

  test("compression ratio past the danger threshold pushes score down", () => {
    const clean = normalizeSegmentConfidence(
      seg({ avgLogprob: 0, noSpeechProb: 0, compressionRatio: 2 }),
    );
    const garbage = normalizeSegmentConfidence(
      seg({ avgLogprob: 0, noSpeechProb: 0, compressionRatio: 4.4 }),
    );
    expect(clean).toBeGreaterThan(garbage);
  });

  describe("3-bucket compression penalty", () => {
    test("ratio <= 1.5 → penalty 1.0 (no reduction)", () => {
      const a = normalizeSegmentConfidence(
        seg({ avgLogprob: 0, noSpeechProb: 0, compressionRatio: 1.0 }),
      );
      const b = normalizeSegmentConfidence(
        seg({ avgLogprob: 0, noSpeechProb: 0, compressionRatio: 1.5 }),
      );
      // Both in the 1.0-penalty bucket → identical scores.
      expect(a).toBeCloseTo(b);
    });

    test("ratio in (1.5, 2] → penalty 0.75 (mild reduction)", () => {
      const noPenalty = normalizeSegmentConfidence(
        seg({ avgLogprob: 0, noSpeechProb: 0, compressionRatio: 1.5 }),
      );
      const mild = normalizeSegmentConfidence(
        seg({ avgLogprob: 0, noSpeechProb: 0, compressionRatio: 1.8 }),
      );
      expect(noPenalty - mild).toBeCloseTo(0.025, 5); // 0.1 * (1.0 - 0.75)
    });

    test("ratio > 2 → penalty 0.5 (sharp reduction)", () => {
      const noPenalty = normalizeSegmentConfidence(
        seg({ avgLogprob: 0, noSpeechProb: 0, compressionRatio: 1.5 }),
      );
      const severe = normalizeSegmentConfidence(
        seg({ avgLogprob: 0, noSpeechProb: 0, compressionRatio: 2.5 }),
      );
      expect(noPenalty - severe).toBeCloseTo(0.05, 5); // 0.1 * (1.0 - 0.5)
    });
  });

  test("prefers detailed signals over passthrough confidence when both present", () => {
    // High `confidence` but poor Whisper signals — detailed signals must win.
    const n = normalizeSegmentConfidence(
      seg({ confidence: 0.95, avgLogprob: -2, noSpeechProb: 0.9, compressionRatio: 4.2 }),
    );
    expect(n).toBeLessThan(0.5);
  });
});

describe("confidenceLevelFor", () => {
  test("HIGH past the high threshold", () => {
    expect(confidenceLevelFor(NORMALIZED_CONFIDENCE_THRESHOLDS.HIGH_MIN + 0.01)).toBe("HIGH");
    expect(confidenceLevelFor(1)).toBe("HIGH");
  });

  test("MEDIUM in the [0.4, 0.75] band", () => {
    expect(confidenceLevelFor(0.4)).toBe("MEDIUM");
    expect(confidenceLevelFor(0.6)).toBe("MEDIUM");
    expect(confidenceLevelFor(0.75)).toBe("MEDIUM");
  });

  test("LOW below the medium threshold", () => {
    expect(confidenceLevelFor(0.39)).toBe("LOW");
    expect(confidenceLevelFor(0)).toBe("LOW");
  });
});

describe("scoreSegments attaches normalized fields", () => {
  test("whisper scale — normalizedConfidence + confidenceLevel appear on every segment", () => {
    const segments: TranscriptSegment[] = [
      seg({ confidence: 0.9, text: "a" }),
      seg({ confidence: 0.2, text: "b", startMs: 1000, endMs: 2000 }),
    ];
    const { segments: scored } = scoreSegments(segments, "whisper");
    expect(scored[0]?.normalizedConfidence).toBeCloseTo(0.9);
    expect(scored[0]?.confidenceLevel).toBe("HIGH");
    expect(scored[1]?.normalizedConfidence).toBeCloseTo(0.2);
    expect(scored[1]?.confidenceLevel).toBe("LOW");
  });

  test('none scale — every segment gets MEDIUM baseline + MEDIUM level', () => {
    const { segments: scored } = scoreSegments(
      [seg({ confidence: 0.01 }), seg({ confidence: 0.99 })],
      "none",
    );
    for (const s of scored) {
      expect(s.tier).toBe("MEDIUM");
      expect(s.normalizedConfidence).toBe(NORMALIZED_CONFIDENCE_NONE_BASELINE);
      expect(s.confidenceLevel).toBe("MEDIUM");
      expect(s.confidence).toBeUndefined();
    }
  });
});
