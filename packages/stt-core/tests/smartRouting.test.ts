/**
 * Smart routing scenarios — covers the personalization layer:
 * region heuristics, language profiles, user preferences, and mode resolution.
 */

import { chooseModel } from "../src/routing/chooseModel";
import { resolveMode } from "../src/routing/chooseMode";
import { computeMultilingualNeed } from "../src/routing/languageProfile";
import { getMultilingualRisk } from "../src/routing/regionHeuristics";
import type {
  DeviceProfile,
  TranscriptionSettings,
  ModelSelectionContext,
  UserSpeechProfile,
} from "../src/types";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const midDevice: DeviceProfile = {
  platform: "android",
  cpuTier: "mid",
  ramMB: 4096,
  storageAvailableMB: 5000,
  batterySaverActive: false,
  lowPowerMode: false,
};

const highEndDevice: DeviceProfile = {
  platform: "windows",
  cpuTier: "high",
  ramMB: 16384,
  storageAvailableMB: 20000,
  batterySaverActive: false,
  lowPowerMode: false,
};

const weakDevice: DeviceProfile = {
  platform: "android",
  cpuTier: "low",
  ramMB: 512,
  storageAvailableMB: 800,
  batterySaverActive: false,
  lowPowerMode: false,
};

const allInstalled = [
  "whisper-turbo",
  "whisper-large-v3",
  "parakeet-v3",
  "moonshine-base",
];

function ctx(
  settings: Partial<TranscriptionSettings>,
  device: DeviceProfile,
  profile?: UserSpeechProfile,
  installed = allInstalled
): ModelSelectionContext {
  return {
    settings: {
      mode: "auto",
      language: "en",
      timestamps: true,
      offlineOnly: true,
      ...settings,
    },
    device,
    userSpeechProfile: profile,
    installedModelIds: installed,
  };
}

// ─── Scenario 1: India + Hindi + English + code-switching ─────────────────────

describe("Scenario 1: India + Hindi + English + mixesLanguages", () => {
  const indianProfile: UserSpeechProfile = {
    countryCode: "IN",
    primaryLanguages: ["en", "hi"],
    mixesLanguages: true,
  };

  it("prefers a multilingual model over English-only fast model", () => {
    const result = chooseModel(ctx({ mode: "balanced", language: "en" }, midDevice, indianProfile));
    expect(result.selectedModel.capabilities.supportedLanguages).toContain("multilingual");
  });

  it("does not select parakeet-v3 (English-only) as top choice", () => {
    const result = chooseModel(ctx({ mode: "balanced", language: "en" }, midDevice, indianProfile));
    expect(result.selectedModel.id).not.toBe("parakeet-v3");
  });

  it("does not select moonshine-base (English-only, no timestamps) as top choice", () => {
    const result = chooseModel(ctx({ mode: "balanced", language: "en" }, midDevice, indianProfile));
    expect(result.selectedModel.id).not.toBe("moonshine-base");
  });

  it("tags multilingual-bias in appliedBiases", () => {
    const result = chooseModel(ctx({ mode: "balanced", language: "en" }, midDevice, indianProfile));
    expect(result.appliedBiases.some((b) => b.startsWith("multilingual-bias"))).toBe(true);
  });

  it("tags region:IN in appliedBiases", () => {
    const result = chooseModel(ctx({ mode: "balanced", language: "en" }, midDevice, indianProfile));
    expect(result.appliedBiases).toContain("region:IN");
  });

  it("tags code-switching-detected in appliedBiases", () => {
    const result = chooseModel(ctx({ mode: "balanced", language: "en" }, midDevice, indianProfile));
    expect(result.appliedBiases).toContain("code-switching-detected");
  });

  it("multilingual need is high for India+Hindi+English+mixesLanguages", () => {
    const settings: TranscriptionSettings = {
      mode: "balanced", language: "en", timestamps: true, offlineOnly: true,
    };
    const need = computeMultilingualNeed(settings, indianProfile, "IN");
    expect(need).toBeGreaterThan(0.7);
  });
});

// ─── Scenario 2: US + English only + weak device ─────────────────────────────

describe("Scenario 2: US + English only + weak device", () => {
  const usProfile: UserSpeechProfile = {
    countryCode: "US",
    primaryLanguages: ["en"],
    mixesLanguages: false,
  };

  it("selects a language-specific English model when available", () => {
    const result = chooseModel(ctx({ mode: "fast", language: "en" }, weakDevice, usProfile));
    // parakeet-v3 or moonshine-base should win — both are English-only and fast/realtime
    const winnerId = result.selectedModel.id;
    expect(["parakeet-v3", "moonshine-base"]).toContain(winnerId);
  });

  it("multilingual need is low for US English-only user", () => {
    const settings: TranscriptionSettings = {
      mode: "fast", language: "en", timestamps: true, offlineOnly: true,
    };
    const need = computeMultilingualNeed(settings, usProfile, "US");
    expect(need).toBeLessThan(0.3);
  });

  it("does not tag multilingual-bias for US English-only", () => {
    const result = chooseModel(ctx({ mode: "fast", language: "en" }, weakDevice, usProfile));
    expect(result.appliedBiases.some((b) => b.startsWith("multilingual-bias"))).toBe(false);
  });

  it("region risk for US is none", () => {
    expect(getMultilingualRisk("US")).toBe("none");
  });
});

// ─── Scenario 3: France + French + English ────────────────────────────────────

describe("Scenario 3: France + French + English (multilingual language setting)", () => {
  const frenchProfile: UserSpeechProfile = {
    countryCode: "FR",
    primaryLanguages: ["fr", "en"],
    mixesLanguages: false,
  };

  it("selects a multilingual model when language=multilingual", () => {
    // French+English requires multilingual capability — stage 1 filters English-only
    const result = chooseModel(
      ctx({ mode: "balanced", language: "multilingual" }, midDevice, frenchProfile)
    );
    expect(result.selectedModel.capabilities.supportedLanguages).toContain("multilingual");
  });

  it("rejects English-only models in rejectedCandidates for multilingual language", () => {
    const result = chooseModel(
      ctx({ mode: "balanced", language: "multilingual" }, midDevice, frenchProfile)
    );
    const rejected = result.rejectedCandidates.map((r) => r.modelId);
    expect(rejected).toContain("parakeet-v3");
    expect(rejected).toContain("moonshine-base");
  });

  it("multilingual need is elevated for two-language profile", () => {
    const settings: TranscriptionSettings = {
      mode: "balanced", language: "en", timestamps: true, offlineOnly: true,
    };
    const need = computeMultilingualNeed(settings, frenchProfile, "FR");
    expect(need).toBeGreaterThanOrEqual(0.2);
  });
});

// ─── Scenario 4: Low storage preference ──────────────────────────────────────

describe("Scenario 4: User prefers low storage", () => {
  const storageProfile: UserSpeechProfile = {
    countryCode: "US",
    primaryLanguages: ["en"],
    prefersLowStorageUsage: true,
  };

  it("penalizes the large whisper-large-v3 in favor of compact models", () => {
    const result = chooseModel(
      ctx({ mode: "balanced", language: "en" }, highEndDevice, storageProfile)
    );
    // whisper-large-v3 is "large" memory profile — should lose to smaller models
    expect(result.selectedModel.id).not.toBe("whisper-large-v3");
  });

  it("tags storage-preference in appliedBiases", () => {
    const result = chooseModel(
      ctx({ mode: "balanced", language: "en" }, highEndDevice, storageProfile)
    );
    expect(result.appliedBiases).toContain("storage-preference");
  });

  it("whisper-large-v3 appears in rejectedCandidates or is outscored (not selected)", () => {
    const result = chooseModel(
      ctx({ mode: "balanced", language: "en" }, highEndDevice, storageProfile)
    );
    // It should be either rejected or in fallbacks, never the winner
    expect(result.selectedModel.id).not.toBe("whisper-large-v3");
  });
});

// ─── Scenario 5: Exact model override (valid) ─────────────────────────────────

describe("Scenario 5: Exact model override — valid", () => {
  it("returns the pinned model when it is installed and compatible", () => {
    const result = chooseModel(
      ctx({ exactModelId: "parakeet-v3", language: "en" }, highEndDevice)
    );
    expect(result.selectedModel.id).toBe("parakeet-v3");
    expect(result.selectionReasons[0]).toContain("Pinned by exactModelId");
  });

  it("returns empty fallbackCandidates when pinned", () => {
    const result = chooseModel(
      ctx({ exactModelId: "whisper-turbo", language: "en" }, highEndDevice)
    );
    expect(result.fallbackCandidates).toHaveLength(0);
  });
});

// ─── Scenario 6: Exact model override (invalid) ───────────────────────────────

describe("Scenario 6: Exact model override — invalid / not installed", () => {
  it("falls back safely when pinned model is not installed", () => {
    const installed = ["whisper-turbo", "parakeet-v3"];
    const result = chooseModel(
      ctx({ exactModelId: "whisper-large-v3", language: "en" }, highEndDevice, undefined, installed)
    );
    expect(result.selectedModel.id).not.toBe("whisper-large-v3");
    expect(result.rejectedCandidates.some((r) => r.modelId === "whisper-large-v3")).toBe(true);
  });

  it("falls back safely when pinned model is not in the registry", () => {
    const result = chooseModel(
      ctx({ exactModelId: "made-up-model-xyz", language: "en" }, highEndDevice)
    );
    expect(result.rejectedCandidates.some((r) => r.modelId === "made-up-model-xyz")).toBe(true);
    expect(result.selectionReasons[0]).not.toContain("Pinned");
  });

  it("rejected reason is human-readable", () => {
    const installed = ["whisper-turbo"];
    const result = chooseModel(
      ctx({ exactModelId: "parakeet-v3", language: "en" }, highEndDevice, undefined, installed)
    );
    const parakeetRejection = result.rejectedCandidates.find((r) => r.modelId === "parakeet-v3");
    expect(parakeetRejection?.reason).toContain("not installed");
  });
});

// ─── Scenario 7: Multilingual language request penalizes English-only models ──

describe("Scenario 7: language=multilingual → English-only models filtered", () => {
  it("filters parakeet-v3 (English-only) when language is multilingual", () => {
    const result = chooseModel(ctx({ mode: "balanced", language: "multilingual" }, highEndDevice));
    const rejected = result.rejectedCandidates.map((r) => r.modelId);
    expect(rejected).toContain("parakeet-v3");
  });

  it("filters moonshine-base (English-only) when language is multilingual", () => {
    const result = chooseModel(ctx({ mode: "balanced", language: "multilingual" }, highEndDevice));
    const rejected = result.rejectedCandidates.map((r) => r.modelId);
    expect(rejected).toContain("moonshine-base");
  });

  it("selected model supports multilingual", () => {
    const result = chooseModel(ctx({ mode: "balanced", language: "multilingual" }, highEndDevice));
    expect(result.selectedModel.capabilities.supportedLanguages).toContain("multilingual");
  });

  it("language=hinglish also filters English-only models", () => {
    const result = chooseModel(ctx({ mode: "balanced", language: "hinglish" }, midDevice));
    const rejected = result.rejectedCandidates.map((r) => r.modelId);
    expect(rejected).toContain("parakeet-v3");
    expect(result.selectedModel.capabilities.supportedLanguages).toContain("multilingual");
  });
});

// ─── Scenario 8: Auto mode resolution ────────────────────────────────────────

describe("Scenario 8: Auto mode resolution", () => {
  it("resolves auto to fast on low-end device", () => {
    const result = resolveMode("auto", weakDevice);
    expect(result.mode).toBe("fast");
    expect(result.reason).toBeTruthy();
  });

  it("resolves auto to best_accuracy on high-end device", () => {
    const result = resolveMode("auto", highEndDevice);
    expect(result.mode).toBe("best_accuracy");
  });

  it("resolves auto to fast when battery saver is on", () => {
    const device: DeviceProfile = { ...midDevice, batterySaverActive: true };
    const result = resolveMode("auto", device);
    expect(result.mode).toBe("fast");
    expect(result.reason).toContain("battery");
  });

  it("respects user preferredMode from onboarding profile", () => {
    const profile: UserSpeechProfile = { preferredMode: "best_accuracy" };
    const result = resolveMode("auto", midDevice, undefined, profile);
    expect(result.mode).toBe("best_accuracy");
    expect(result.reason).toContain("onboarding preference");
  });

  it("prefers balanced for user who prefers low battery (auto)", () => {
    const profile: UserSpeechProfile = { prefersLowBatteryUsage: true };
    const result = resolveMode("auto", highEndDevice, undefined, profile);
    expect(result.mode).toBe("balanced");
    expect(result.reason).toContain("battery");
  });

  it("resolves auto to balanced for high multilingual need on mid device", () => {
    const settings: TranscriptionSettings = {
      mode: "auto", language: "multilingual", timestamps: true, offlineOnly: true,
    };
    const profile: UserSpeechProfile = {
      countryCode: "IN",
      primaryLanguages: ["en", "hi"],
      mixesLanguages: true,
    };
    const result = resolveMode("auto", midDevice, settings, profile);
    // High multilingual need on mid-tier device → balanced (not fast)
    expect(result.mode).not.toBe("fast");
  });

  it("always returns a human-readable reason", () => {
    const modes = ["auto", "fast", "balanced", "best_accuracy"] as const;
    for (const m of modes) {
      const result = resolveMode(m, midDevice);
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(5);
    }
  });
});

// ─── Region heuristics unit tests ─────────────────────────────────────────────

describe("Region heuristics", () => {
  it("classifies India as high code-switching risk", () => {
    expect(getMultilingualRisk("IN")).toBe("high");
  });

  it("classifies US as none (English dominant)", () => {
    expect(getMultilingualRisk("US")).toBe("none");
  });

  it("classifies South Africa as medium risk", () => {
    expect(getMultilingualRisk("ZA")).toBe("medium");
  });

  it("classifies unknown country as low risk", () => {
    expect(getMultilingualRisk("XX")).toBe("low");
    expect(getMultilingualRisk(undefined)).toBe("low");
  });

  it("is case-insensitive", () => {
    expect(getMultilingualRisk("in")).toBe("high");
    expect(getMultilingualRisk("In")).toBe("high");
  });
});
