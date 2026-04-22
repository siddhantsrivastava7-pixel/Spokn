import {
  CONFIDENCE_THRESHOLDS,
  aggregateTier,
  heuristicTier,
  scoreSegment,
  scoreSegments,
  tierFor,
} from "../src/analysis/segmentConfidence";
import type { TranscriptSegment } from "../src/types";

describe("segmentConfidence", () => {
  describe("tierFor locked thresholds", () => {
    test("HIGH at the boundary (0.6)", () => {
      expect(tierFor(CONFIDENCE_THRESHOLDS.HIGH_MIN)).toBe("HIGH");
      expect(tierFor(1.0)).toBe("HIGH");
    });

    test("MEDIUM spans 0.3 <= c < 0.6", () => {
      expect(tierFor(CONFIDENCE_THRESHOLDS.MEDIUM_MIN)).toBe("MEDIUM");
      expect(tierFor(0.45)).toBe("MEDIUM");
      expect(tierFor(0.59999)).toBe("MEDIUM");
    });

    test("LOW below 0.3", () => {
      expect(tierFor(0.29999)).toBe("LOW");
      expect(tierFor(0)).toBe("LOW");
    });
  });

  describe("heuristicTier fallback", () => {
    test("very short segment → MEDIUM", () => {
      const seg: TranscriptSegment = { startMs: 0, endMs: 150, text: "hi" };
      expect(heuristicTier(seg)).toBe("MEDIUM");
    });

    test("repeated tokens → MEDIUM", () => {
      const seg: TranscriptSegment = {
        startMs: 0,
        endMs: 2000,
        text: "the the report",
      };
      expect(heuristicTier(seg)).toBe("MEDIUM");
    });

    test("normal segment → HIGH", () => {
      const seg: TranscriptSegment = {
        startMs: 0,
        endMs: 2000,
        text: "we shipped the feature",
      };
      expect(heuristicTier(seg)).toBe("HIGH");
    });
  });

  describe("scoreSegment", () => {
    test("uses confidence when present", () => {
      const scored = scoreSegment({
        startMs: 0,
        endMs: 1000,
        text: "hello",
        confidence: 0.25,
      });
      expect(scored.tier).toBe("LOW");
    });

    test("falls back to heuristic when confidence absent", () => {
      const scored = scoreSegment({ startMs: 0, endMs: 150, text: "hi" });
      expect(scored.tier).toBe("MEDIUM");
    });
  });

  describe("aggregateTier", () => {
    test("LOW dominates", () => {
      expect(aggregateTier({ HIGH: 5, MEDIUM: 2, LOW: 1 })).toBe("LOW");
    });
    test("MEDIUM in absence of LOW", () => {
      expect(aggregateTier({ HIGH: 5, MEDIUM: 2, LOW: 0 })).toBe("MEDIUM");
    });
    test("empty input → HIGH", () => {
      expect(aggregateTier({ HIGH: 0, MEDIUM: 0, LOW: 0 })).toBe("HIGH");
    });
  });

  describe("scoreSegments", () => {
    test("tags every segment and returns counts + qualityTier", () => {
      const segments: TranscriptSegment[] = [
        { startMs: 0, endMs: 1000, text: "one", confidence: 0.9 },
        { startMs: 1000, endMs: 2000, text: "two", confidence: 0.4 },
        { startMs: 2000, endMs: 3000, text: "three", confidence: 0.1 },
      ];
      const result = scoreSegments(segments);
      expect(result.segments.map((s) => s.tier)).toEqual([
        "HIGH",
        "MEDIUM",
        "LOW",
      ]);
      expect(result.counts).toEqual({ HIGH: 1, MEDIUM: 1, LOW: 1 });
      expect(result.qualityTier).toBe("LOW");
    });
  });
});
