import {
  DEFAULT_THRESHOLDS,
  parseFfmpegProbeOutput,
} from "../src/preprocessing/AudioQualityAnalyzer";

// Parser-only tests — we exercise the decision logic without spawning ffmpeg.
// Full integration is covered via AdaptiveBackend tests that inject a fake inner
// backend and skip the ffmpeg probe when ffmpeg is absent on the test machine.

const CLEAN_STDERR = `
  Duration: 00:00:10.00, start: 0.000000, bitrate: 256 kb/s
  Stream #0:0
[Parsed_volumedetect_0 @ 0x1] n_samples: 160000
[Parsed_volumedetect_0 @ 0x1] mean_volume: -18.5 dB
[Parsed_volumedetect_0 @ 0x1] max_volume: -3.0 dB
[Parsed_volumedetect_0 @ 0x1] histogram_0db: 0
[Parsed_volumedetect_0 @ 0x1] histogram_-3db: 40000
[Parsed_volumedetect_0 @ 0x1] histogram_-18db: 100000
[Parsed_volumedetect_0 @ 0x1] histogram_-60db: 20000
`;

const QUIET_STDERR = `
  Duration: 00:00:10.00, start: 0.000000
[Parsed_volumedetect_0 @ 0x1] mean_volume: -38.0 dB
[Parsed_volumedetect_0 @ 0x1] max_volume: -20.0 dB
[Parsed_volumedetect_0 @ 0x1] histogram_-20db: 5000
[Parsed_volumedetect_0 @ 0x1] histogram_-38db: 100000
`;

const CLIPPED_STDERR = `
  Duration: 00:00:05.00
[Parsed_volumedetect_0 @ 0x1] mean_volume: -12.0 dB
[Parsed_volumedetect_0 @ 0x1] max_volume: -0.1 dB
[Parsed_volumedetect_0 @ 0x1] histogram_0db: 5000
[Parsed_volumedetect_0 @ 0x1] histogram_-12db: 100000
`;

const NOISY_STDERR = `
  Duration: 00:00:10.00
[Parsed_volumedetect_0 @ 0x1] mean_volume: -20.0 dB
[Parsed_volumedetect_0 @ 0x1] max_volume: -3.0 dB
[Parsed_volumedetect_0 @ 0x1] histogram_-3db: 5000
[Parsed_volumedetect_0 @ 0x1] histogram_-20db: 120000
[Parsed_volumedetect_0 @ 0x1] histogram_-30db: 200
`;

const SILENT_HEAVY_STDERR = `
  Duration: 00:00:10.00
[Parsed_volumedetect_0 @ 0x1] mean_volume: -25.0 dB
[Parsed_volumedetect_0 @ 0x1] max_volume: -3.0 dB
[Parsed_volumedetect_0 @ 0x1] histogram_-3db: 40000
[Parsed_volumedetect_0 @ 0x1] histogram_-25db: 120000
[Parsed_volumedetect_0 @ 0x1] histogram_-80db: 500
[silencedetect @ 0x1] silence_start: 0.000000
[silencedetect @ 0x1] silence_end: 8.500000 | silence_duration: 8.500000
`;

describe("parseFfmpegProbeOutput", () => {
  test("clean audio: needsPreprocessing=false", () => {
    const m = parseFfmpegProbeOutput(CLEAN_STDERR, DEFAULT_THRESHOLDS);
    expect(m.rmsDb).toBe(-18.5);
    expect(m.peakDb).toBe(-3);
    expect(m.needsPreprocessing).toBe(false);
    expect(m.reasons).toHaveLength(0);
  });

  test("quiet audio: flagged as rms_too_low", () => {
    const m = parseFfmpegProbeOutput(QUIET_STDERR, DEFAULT_THRESHOLDS);
    expect(m.needsPreprocessing).toBe(true);
    expect(m.reasons.some((r) => r.startsWith("rms_too_low"))).toBe(true);
  });

  test("clipped audio: flagged as clipping", () => {
    const m = parseFfmpegProbeOutput(CLIPPED_STDERR, DEFAULT_THRESHOLDS);
    expect(m.needsPreprocessing).toBe(true);
    expect(m.reasons.some((r) => r.startsWith("clipping"))).toBe(true);
    expect(m.clippingRatio).toBeGreaterThan(0);
  });

  test("noisy audio: flagged as noisy_floor", () => {
    const m = parseFfmpegProbeOutput(NOISY_STDERR, DEFAULT_THRESHOLDS);
    expect(m.needsPreprocessing).toBe(true);
    expect(m.reasons.some((r) => r.startsWith("noisy_floor"))).toBe(true);
    expect(m.estimatedNoiseFloorDb).toBeGreaterThanOrEqual(-45);
  });

  test("mostly-silent audio: flagged as mostly_silent", () => {
    const m = parseFfmpegProbeOutput(SILENT_HEAVY_STDERR, DEFAULT_THRESHOLDS);
    expect(m.needsPreprocessing).toBe(true);
    expect(m.reasons.some((r) => r.startsWith("mostly_silent"))).toBe(true);
    expect(m.silenceRatio).toBeGreaterThan(0.5);
  });

  test("custom thresholds override defaults", () => {
    const m = parseFfmpegProbeOutput(CLEAN_STDERR, {
      ...DEFAULT_THRESHOLDS,
      minRmsDb: -10, // very strict — the clean clip now fails
    });
    expect(m.needsPreprocessing).toBe(true);
  });

  test("empty stderr produces safe defaults", () => {
    const m = parseFfmpegProbeOutput("", DEFAULT_THRESHOLDS);
    expect(m.rmsDb).toBe(0);
    expect(m.peakDb).toBe(0);
    // peakDb=0 → assumed clipping over threshold → flagged.
    expect(m.needsPreprocessing).toBe(true);
  });
});
