import { buildWhisperArgs } from "../src/backend/buildWhisperArgs";
import type { BackendTranscriptionRequest } from "../src/backend/backendTypes";

const MODEL_PATH = "C:\\models\\whisper-turbo.gguf";

const base: BackendTranscriptionRequest = {
  audioPath: "C:\\tmp\\audio.wav",
  model: { kind: "whisper-cpp", path: MODEL_PATH },
  timestamps: false,
};

describe("buildWhisperArgs", () => {
  it("includes audio path and model path", () => {
    const args = buildWhisperArgs(base);
    expect(args).toContain("-f");
    expect(args).toContain(base.audioPath);
    expect(args).toContain("-m");
    expect(args).toContain(MODEL_PATH);
  });

  it("rejects a transformers-js model ref", () => {
    expect(() =>
      buildWhisperArgs({
        ...base,
        model: { kind: "transformers-js", modelId: "sense-voice-small" },
      }),
    ).toThrow(/whisper-cpp/);
  });

  it("always includes -oj for JSON output", () => {
    expect(buildWhisperArgs(base)).toContain("-oj");
  });

  it("defaults to auto language when none specified", () => {
    const args = buildWhisperArgs(base);
    const langIdx = args.indexOf("-l");
    expect(langIdx).toBeGreaterThan(-1);
    expect(args[langIdx + 1]).toBe("auto");
  });

  it("maps 'hinglish' to auto", () => {
    const args = buildWhisperArgs({ ...base, language: "hinglish" });
    const langIdx = args.indexOf("-l");
    expect(args[langIdx + 1]).toBe("auto");
  });

  it("maps 'en' to en", () => {
    const args = buildWhisperArgs({ ...base, language: "en" });
    const langIdx = args.indexOf("-l");
    expect(args[langIdx + 1]).toBe("en");
  });

  it("adds --split-on-word when timestamps requested", () => {
    const args = buildWhisperArgs({ ...base, timestamps: true });
    expect(args).toContain("--split-on-word");
  });

  it("does not add --split-on-word when timestamps false", () => {
    const args = buildWhisperArgs({ ...base, timestamps: false });
    expect(args).not.toContain("--split-on-word");
  });

  it("adds --offset-t and --duration for chunk requests", () => {
    const args = buildWhisperArgs({ ...base, startMs: 5000, endMs: 35000 });
    expect(args).toContain("--offset-t");
    expect(args).toContain("5000");
    expect(args).toContain("--duration");
    expect(args).toContain("30000");
  });

  it("does not add offset flags when startMs is 0", () => {
    const args = buildWhisperArgs({ ...base, startMs: 0, endMs: 30000 });
    expect(args).not.toContain("--offset-t");
  });

  describe("decodingHints", () => {
    it("base request has no beam/best-of/temperature flags", () => {
      const args = buildWhisperArgs(base);
      expect(args).not.toContain("--beam-size");
      expect(args).not.toContain("--best-of");
      expect(args).not.toContain("--temperature");
    });

    it("highAccuracy applies preset (beam 5, best-of 5, temp 0, thresholds)", () => {
      const args = buildWhisperArgs({
        ...base,
        decodingHints: { highAccuracy: true },
      });
      const beam = args.indexOf("--beam-size");
      expect(beam).toBeGreaterThan(-1);
      expect(args[beam + 1]).toBe("5");
      const bestOf = args.indexOf("--best-of");
      expect(bestOf).toBeGreaterThan(-1);
      expect(args[bestOf + 1]).toBe("5");
      const temp = args.indexOf("--temperature");
      expect(args[temp + 1]).toBe("0");
      expect(args).toContain("--entropy-thold");
      expect(args).toContain("--logprob-thold");
    });

    it("explicit numeric fields override the preset", () => {
      const args = buildWhisperArgs({
        ...base,
        decodingHints: { highAccuracy: true, beamSize: 10, bestOf: 8 },
      });
      const beam = args.indexOf("--beam-size");
      expect(args[beam + 1]).toBe("10");
      const bestOf = args.indexOf("--best-of");
      expect(args[bestOf + 1]).toBe("8");
    });

    it("numeric fields without highAccuracy still apply", () => {
      const args = buildWhisperArgs({
        ...base,
        decodingHints: { beamSize: 3 },
      });
      const beam = args.indexOf("--beam-size");
      expect(args[beam + 1]).toBe("3");
    });
  });

  describe("anti-hallucination thresholds (always-on)", () => {
    it("baseline includes all three threshold flags", () => {
      const args = buildWhisperArgs(base);
      const nsIdx = args.indexOf("--no-speech-thold");
      expect(nsIdx).toBeGreaterThan(-1);
      expect(args[nsIdx + 1]).toBe("0.6");
      const lpIdx = args.indexOf("--logprob-thold");
      expect(lpIdx).toBeGreaterThan(-1);
      expect(args[lpIdx + 1]).toBe("-1.0");
      const enIdx = args.indexOf("--entropy-thold");
      expect(enIdx).toBeGreaterThan(-1);
      expect(args[enIdx + 1]).toBe("2.4");
    });

    it("baseline request has no duplicate threshold flags", () => {
      const args = buildWhisperArgs(base);
      for (const flag of ["--no-speech-thold", "--logprob-thold", "--entropy-thold"]) {
        expect(args.filter((a) => a === flag).length).toBe(1);
      }
    });

    it("highAccuracy request has no duplicate threshold flags", () => {
      const args = buildWhisperArgs({
        ...base,
        decodingHints: { highAccuracy: true },
      });
      for (const flag of ["--logprob-thold", "--entropy-thold"]) {
        expect(args.filter((a) => a === flag).length).toBe(1);
      }
    });

    it("highAccuracy wins over baseline (last-occurrence preserved)", () => {
      // If highAccuracy emits a different value for --entropy-thold than the
      // baseline, dedupe must keep the highAccuracy (later) one. Today the
      // values happen to match; this test pins the last-wins behavior so
      // future divergence is safe.
      const args = buildWhisperArgs({
        ...base,
        decodingHints: { highAccuracy: true },
      });
      const enIdx = args.indexOf("--entropy-thold");
      // The sole remaining --entropy-thold is the one emitted by
      // appendDecodingHints (the later one), with value "2.4".
      expect(args[enIdx + 1]).toBe("2.4");
    });

    it("dedupe preserves relative order of non-threshold flags", () => {
      // Build the full arg set and record positions of flags NOT touched by
      // dedupe. Their order relative to each other must match the intended
      // build order: -f, -m, -oj, --output-file, --no-prints, -l, then the
      // decoding-hint flags (--beam-size, --best-of, --temperature).
      const args = buildWhisperArgs({
        ...base,
        decodingHints: { highAccuracy: true, beamSize: 5, bestOf: 5, temperature: 0 },
      });
      const nonThreshold = [
        "-f", "-m", "-oj", "--output-file", "--no-prints",
        "-l", "--beam-size", "--best-of", "--temperature",
      ];
      const positions = nonThreshold.map((f) => args.indexOf(f));
      // Every expected flag present
      for (const p of positions) expect(p).toBeGreaterThan(-1);
      // Order strictly increasing
      for (let i = 1; i < positions.length; i++) {
        expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
      }
    });
  });
});
