import { validateSettings, mergeWithDefaults } from "../src/settings/validateSettings";
import { DEFAULT_SETTINGS } from "../src/settings/defaultSettings";
import type { TranscriptionSettings } from "../src/types";

const validSettings: TranscriptionSettings = {
  mode: "balanced",
  language: "en",
  timestamps: true,
  offlineOnly: true,
};

describe("validateSettings", () => {
  it("passes for fully valid settings", () => {
    const result = validateSettings(validSettings);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects an invalid mode", () => {
    const bad = { ...validSettings, mode: "turbo" as never };
    const result = validateSettings(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("mode"))).toBe(true);
  });

  it("rejects an invalid language", () => {
    const bad = { ...validSettings, language: "klingon" as never };
    const result = validateSettings(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("language"))).toBe(true);
  });

  it("rejects chunkDurationMs that is too short", () => {
    const bad: TranscriptionSettings = { ...validSettings, chunkDurationMs: 100 };
    const result = validateSettings(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("chunkDurationMs"))).toBe(true);
  });

  it("rejects chunkDurationMs that is too long", () => {
    const bad: TranscriptionSettings = {
      ...validSettings,
      chunkDurationMs: 999_999_999,
    };
    const result = validateSettings(bad);
    expect(result.valid).toBe(false);
  });

  it("accepts chunkDurationMs within valid range", () => {
    const good: TranscriptionSettings = {
      ...validSettings,
      chunkDurationMs: 30_000,
    };
    expect(validateSettings(good).valid).toBe(true);
  });

  it("accepts maxDurationMs within valid range", () => {
    const good: TranscriptionSettings = {
      ...validSettings,
      maxDurationMs: 3_600_000,
    };
    expect(validateSettings(good).valid).toBe(true);
  });

  it("rejects maxDurationMs exceeding ceiling", () => {
    const bad: TranscriptionSettings = {
      ...validSettings,
      maxDurationMs: 99_999_999,
    };
    expect(validateSettings(bad).valid).toBe(false);
  });

  it("returns multiple errors when multiple fields are invalid", () => {
    const bad = {
      ...validSettings,
      mode: "bad_mode" as never,
      language: "bad_lang" as never,
    };
    const result = validateSettings(bad);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("mergeWithDefaults", () => {
  it("fills in default fields when partial is provided", () => {
    const merged = mergeWithDefaults({ mode: "fast" });
    expect(merged.mode).toBe("fast");
    expect(merged.language).toBe(DEFAULT_SETTINGS.language);
    expect(merged.timestamps).toBe(DEFAULT_SETTINGS.timestamps);
    expect(merged.offlineOnly).toBe(DEFAULT_SETTINGS.offlineOnly);
  });

  it("does not mutate DEFAULT_SETTINGS", () => {
    const before = { ...DEFAULT_SETTINGS };
    mergeWithDefaults({ mode: "best_accuracy", language: "hi" });
    expect(DEFAULT_SETTINGS).toEqual(before);
  });

  it("overrides all fields when all are supplied", () => {
    const custom: TranscriptionSettings = {
      mode: "best_accuracy",
      language: "hi",
      timestamps: false,
      offlineOnly: false,
      chunkDurationMs: 120_000,
    };
    const merged = mergeWithDefaults(custom);
    expect(merged).toEqual(custom);
  });
});
