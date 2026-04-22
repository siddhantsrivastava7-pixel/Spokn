import { finalizeTranscript } from "../src/pipeline/finalizeTranscript";
import { mergeTranscripts } from "../src/transcript/transcriptMerge";
import {
  serializeTranscript,
  deserializeTranscript,
  exportAsSRT,
  exportAsPlainText,
} from "../src/transcript/transcriptSerializer";
import {
  buildFullText,
  averageConfidence,
  wordCount,
  sliceSegments,
} from "../src/transcript/transcriptUtils";
import type { TranscriptSegment, Transcript } from "../src/types";

const segments: TranscriptSegment[] = [
  { startMs: 0, endMs: 2000, text: "Hello world", confidence: 0.95 },
  { startMs: 2000, endMs: 5000, text: "this is a test", confidence: 0.88 },
  { startMs: 5000, endMs: 8000, text: "of the stt core", confidence: 0.92 },
];

describe("finalizeTranscript", () => {
  it("builds a complete Transcript from segments", () => {
    const t = finalizeTranscript({
      segments,
      language: "en",
      durationMs: 8000,
      modelId: "parakeet-v3",
      mode: "balanced",
    });

    expect(t.id).toBeTruthy();
    expect(t.fullText).toBe("Hello world this is a test of the stt core");
    expect(t.language).toBe("en");
    expect(t.modelId).toBe("parakeet-v3");
    expect(t.segments).toHaveLength(3);
    expect(t.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("deduplicates exact-duplicate segments", () => {
    const duped: TranscriptSegment[] = [
      ...segments,
      { startMs: 0, endMs: 2000, text: "Hello world", confidence: 0.95 },
    ];
    const t = finalizeTranscript({
      segments: duped,
      language: "en",
      durationMs: 8000,
      modelId: "parakeet-v3",
      mode: "fast",
    });
    expect(t.segments).toHaveLength(3);
  });

  it("sorts segments by startMs", () => {
    const shuffled: TranscriptSegment[] = [...segments].reverse();
    const t = finalizeTranscript({
      segments: shuffled,
      language: "en",
      durationMs: 8000,
      modelId: "parakeet-v3",
      mode: "balanced",
    });
    for (let i = 1; i < t.segments.length; i++) {
      expect(t.segments[i].startMs).toBeGreaterThanOrEqual(
        t.segments[i - 1].startMs
      );
    }
  });

  it("accepts optional metadata", () => {
    const t = finalizeTranscript({
      segments,
      language: "en",
      durationMs: 8000,
      modelId: "moonshine-base",
      mode: "fast",
      metadata: { source: "test-run" },
    });
    expect(t.metadata).toMatchObject({ source: "test-run" });
  });
});

describe("mergeTranscripts", () => {
  const makeTranscript = (offset: number): Transcript =>
    finalizeTranscript({
      segments: segments.map((s) => ({
        ...s,
        startMs: s.startMs + offset,
        endMs: s.endMs + offset,
      })),
      language: "en",
      durationMs: 8000,
      modelId: "parakeet-v3",
      mode: "balanced",
    });

  it("merges two transcripts into one sorted result", () => {
    const t1 = makeTranscript(0);
    const t2 = makeTranscript(8000);
    const merged = mergeTranscripts([t1, t2]);
    expect(merged.segments).toHaveLength(6);
    expect(merged.durationMs).toBe(16000);
    expect(merged.metadata).toMatchObject({
      mergedFrom: [t1.id, t2.id],
    });
  });

  it("returns the same transcript when given a single input", () => {
    const t = makeTranscript(0);
    expect(mergeTranscripts([t])).toBe(t);
  });

  it("throws when given an empty array", () => {
    expect(() => mergeTranscripts([])).toThrow();
  });
});

describe("transcriptSerializer", () => {
  const t = finalizeTranscript({
    segments,
    language: "en",
    durationMs: 8000,
    modelId: "parakeet-v3",
    mode: "balanced",
  });

  it("round-trips through serialize/deserialize", () => {
    const json = serializeTranscript(t);
    const restored = deserializeTranscript(json);
    expect(restored.id).toBe(t.id);
    expect(restored.fullText).toBe(t.fullText);
    expect(restored.segments).toHaveLength(t.segments.length);
  });

  it("throws when deserializing invalid JSON", () => {
    expect(() => deserializeTranscript("not json")).toThrow();
  });

  it("throws when required fields are missing", () => {
    const incomplete = JSON.stringify({ id: "x", fullText: "y" });
    expect(() => deserializeTranscript(incomplete)).toThrow(/missing required field/);
  });

  it("exports as plain text", () => {
    const text = exportAsPlainText(t);
    expect(text).toContain("Transcript");
    expect(text).toContain(t.fullText);
    expect(text).toContain("en");
  });

  it("exports as SRT with correct format", () => {
    const srt = exportAsSRT(t);
    expect(srt).toContain("-->"); // SRT timestamp separator
    expect(srt).toContain("Hello world");
    expect(srt).toMatch(/^1\n/);
  });
});

describe("transcriptUtils", () => {
  it("buildFullText joins and trims segments", () => {
    const text = buildFullText(segments);
    expect(text).toBe("Hello world this is a test of the stt core");
  });

  it("averageConfidence returns mean of scored segments", () => {
    const avg = averageConfidence(segments);
    expect(avg).toBeCloseTo((0.95 + 0.88 + 0.92) / 3, 5);
  });

  it("averageConfidence returns undefined when no segments have scores", () => {
    const unscored: TranscriptSegment[] = [{ startMs: 0, endMs: 1000, text: "hi" }];
    expect(averageConfidence(unscored)).toBeUndefined();
  });

  it("wordCount returns correct count", () => {
    const t = finalizeTranscript({
      segments,
      language: "en",
      durationMs: 8000,
      modelId: "parakeet-v3",
      mode: "fast",
    });
    expect(wordCount(t)).toBe(10); // "Hello world this is a test of the stt core"
  });

  it("sliceSegments filters by time range", () => {
    const sliced = sliceSegments(segments, 0, 2000);
    expect(sliced).toHaveLength(1);
    expect(sliced[0].text).toBe("Hello world");
  });
});
