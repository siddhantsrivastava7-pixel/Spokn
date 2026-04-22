import { parseWhisperJsonString } from "../src/backend/parseWhisperOutput";
import { OutputParseError } from "../src/errors";

const SAMPLE_OUTPUT = JSON.stringify({
  systeminfo: "AVX = 1",
  model: { type: "whisper-turbo" },
  params: { language: "auto" },
  result: { language: "english" },
  transcription: [
    {
      timestamps: { from: "00:00:00,000", to: "00:00:03,120" },
      offsets: { from: 0, to: 3120 },
      text: " Hello, world.",
      tokens: [{ text: "Hello", p: 0.95 }, { text: "world", p: 0.88 }],
    },
    {
      timestamps: { from: "00:00:03,120", to: "00:00:07,500" },
      offsets: { from: 3120, to: 7500 },
      text: " This is a test.",
      tokens: [{ text: "This", p: 0.91 }, { text: "is", p: 0.97 }],
    },
  ],
});

describe("parseWhisperJsonString", () => {
  it("parses segments with correct timestamps", () => {
    const result = parseWhisperJsonString(SAMPLE_OUTPUT);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.startMs).toBe(0);
    expect(result.segments[0]?.endMs).toBe(3120);
    expect(result.segments[1]?.startMs).toBe(3120);
    expect(result.segments[1]?.endMs).toBe(7500);
  });

  it("trims segment text", () => {
    const result = parseWhisperJsonString(SAMPLE_OUTPUT);
    expect(result.segments[0]?.text).toBe("Hello, world.");
  });

  it("detects language from result field", () => {
    const result = parseWhisperJsonString(SAMPLE_OUTPUT);
    expect(result.detectedLanguage).toBe("english");
  });

  it("computes durationMs from last segment end", () => {
    const result = parseWhisperJsonString(SAMPLE_OUTPUT);
    expect(result.durationMs).toBe(7500);
  });

  it("computes confidence from token probabilities", () => {
    const result = parseWhisperJsonString(SAMPLE_OUTPUT);
    expect(result.confidence).toBeDefined();
    expect(result.confidence as number).toBeGreaterThan(0);
    expect(result.confidence as number).toBeLessThanOrEqual(1);
  });

  it("handles missing token probabilities gracefully", () => {
    const noTokens = JSON.stringify({
      result: { language: "english" },
      transcription: [
        { offsets: { from: 0, to: 1000 }, text: " Hi" },
      ],
    });
    const result = parseWhisperJsonString(noTokens);
    expect(result.confidence).toBeUndefined();
    expect(result.segments[0]?.confidence).toBeUndefined();
  });

  it("falls back to timestamp parsing when offsets missing", () => {
    const noOffsets = JSON.stringify({
      result: { language: "english" },
      transcription: [
        { timestamps: { from: "00:00:01,500", to: "00:00:04,000" }, text: " Hello" },
      ],
    });
    const result = parseWhisperJsonString(noOffsets);
    expect(result.segments[0]?.startMs).toBe(1500);
    expect(result.segments[0]?.endMs).toBe(4000);
  });

  it("throws OutputParseError for invalid JSON", () => {
    expect(() => parseWhisperJsonString("not json")).toThrow(OutputParseError);
  });

  it("throws OutputParseError when transcription field missing", () => {
    expect(() => parseWhisperJsonString(JSON.stringify({ result: {} }))).toThrow(
      OutputParseError
    );
  });

  describe("decoder signal extraction", () => {
    it("extracts snake_case signals when present at the segment top level", () => {
      const raw = JSON.stringify({
        result: { language: "english" },
        transcription: [
          {
            offsets: { from: 0, to: 1000 },
            text: " Hello",
            avg_logprob: -0.25,
            no_speech_prob: 0.02,
            compression_ratio: 1.4,
          },
        ],
      });
      const seg = parseWhisperJsonString(raw).segments[0]!;
      expect(seg.avgLogprob).toBe(-0.25);
      expect(seg.noSpeechProb).toBe(0.02);
      expect(seg.compressionRatio).toBe(1.4);
    });

    it("extracts camelCase signals", () => {
      const raw = JSON.stringify({
        result: { language: "english" },
        transcription: [
          {
            offsets: { from: 0, to: 1000 },
            text: " Hello",
            avgLogprob: -0.3,
            noSpeechProb: 0.05,
            compressionRatio: 1.7,
          },
        ],
      });
      const seg = parseWhisperJsonString(raw).segments[0]!;
      expect(seg.avgLogprob).toBe(-0.3);
      expect(seg.noSpeechProb).toBe(0.05);
      expect(seg.compressionRatio).toBe(1.7);
    });

    it("extracts signals nested under metrics", () => {
      const raw = JSON.stringify({
        result: { language: "english" },
        transcription: [
          {
            offsets: { from: 0, to: 1000 },
            text: " Hello",
            metrics: {
              avg_logprob: -0.5,
              no_speech_prob: 0.1,
              compression_ratio: 2.1,
            },
          },
        ],
      });
      const seg = parseWhisperJsonString(raw).segments[0]!;
      expect(seg.avgLogprob).toBe(-0.5);
      expect(seg.noSpeechProb).toBe(0.1);
      expect(seg.compressionRatio).toBe(2.1);
    });

    it("leaves fields undefined when absent (no fallback guessing)", () => {
      const raw = JSON.stringify({
        result: { language: "english" },
        transcription: [
          { offsets: { from: 0, to: 1000 }, text: " Hello" },
        ],
      });
      const seg = parseWhisperJsonString(raw).segments[0]!;
      expect(seg.avgLogprob).toBeUndefined();
      expect(seg.noSpeechProb).toBeUndefined();
      expect(seg.compressionRatio).toBeUndefined();
    });

    it("ignores non-numeric or non-finite values", () => {
      const raw = JSON.stringify({
        result: { language: "english" },
        transcription: [
          {
            offsets: { from: 0, to: 1000 },
            text: " Hello",
            avg_logprob: "bad",
            no_speech_prob: null,
            compression_ratio: Number.POSITIVE_INFINITY.toString(),
          },
        ],
      });
      const seg = parseWhisperJsonString(raw).segments[0]!;
      expect(seg.avgLogprob).toBeUndefined();
      expect(seg.noSpeechProb).toBeUndefined();
      expect(seg.compressionRatio).toBeUndefined();
    });
  });
});
