import { chooseModel } from "../src/routing/chooseModel";
import { resolveMode } from "../src/routing/chooseMode";
import type { DeviceProfile, TranscriptionSettings, ModelSelectionContext } from "../src/types";

const highEndDevice: DeviceProfile = {
  platform: "macos",
  cpuTier: "high",
  ramMB: 16384,
  storageAvailableMB: 10000,
  batterySaverActive: false,
  lowPowerMode: false,
  hasNeuralEngine: true,
};

const lowEndDevice: DeviceProfile = {
  platform: "android",
  cpuTier: "low",
  ramMB: 512,
  storageAvailableMB: 500,
  batterySaverActive: false,
  lowPowerMode: false,
};

const baseSettings: TranscriptionSettings = {
  mode: "balanced",
  language: "en",
  timestamps: true,
  offlineOnly: true,
};

const allInstalled = [
  "whisper-turbo",
  "whisper-large-v3",
  "parakeet-v3",
  "moonshine-base",
];

function ctx(
  settings: Partial<TranscriptionSettings> = {},
  device: DeviceProfile = highEndDevice,
  installed: string[] = allInstalled
): ModelSelectionContext {
  return { settings: { ...baseSettings, ...settings }, device, installedModelIds: installed };
}

describe("chooseModel — basic compatibility", () => {
  it("selects a model compatible with the device", () => {
    const result = chooseModel(ctx());
    expect(result.selectedModel).toBeDefined();
    expect(result.selectedModel.capabilities.minRamMB).toBeLessThanOrEqual(highEndDevice.ramMB);
  });

  it("prefers low-latency model for fast mode", () => {
    const result = chooseModel(ctx({ mode: "fast" }));
    expect(result.selectedModel.id).not.toBe("whisper-large-v3");
  });

  it("prefers largest model for best_accuracy on high-end device", () => {
    const result = chooseModel(ctx({ mode: "best_accuracy" }));
    expect(result.selectedModel.id).toBe("whisper-large-v3");
  });

  it("excludes models that exceed device RAM", () => {
    const result = chooseModel(ctx({ mode: "fast" }, lowEndDevice));
    expect(result.selectedModel.capabilities.minRamMB).toBeLessThanOrEqual(lowEndDevice.ramMB);
  });

  it("throws when no compatible model exists", () => {
    const impossibleDevice: DeviceProfile = { ...highEndDevice, ramMB: 1, storageAvailableMB: 1 };
    expect(() => chooseModel(ctx({}, impossibleDevice))).toThrow("No compatible model found");
  });

  it("populates rejectedCandidates for filtered models", () => {
    const result = chooseModel(ctx({ mode: "fast" }, lowEndDevice));
    expect(result.rejectedCandidates.length).toBeGreaterThan(0);
    expect(result.rejectedCandidates.every((r) => typeof r.reason === "string")).toBe(true);
  });
});

describe("chooseModel — exactModelId override", () => {
  it("respects exactModelId when model is compatible", () => {
    const result = chooseModel(ctx({ exactModelId: "parakeet-v3" }));
    expect(result.selectedModel.id).toBe("parakeet-v3");
    expect(result.selectionReasons[0]).toContain("Pinned by exactModelId");
  });

  it("falls back when exactModelId is not installed", () => {
    const installed = ["whisper-turbo", "parakeet-v3", "moonshine-base"];
    const result = chooseModel(ctx({ exactModelId: "whisper-large-v3" }, highEndDevice, installed));
    expect(result.selectedModel.id).not.toBe("whisper-large-v3");
    expect(result.rejectedCandidates.some((r) => r.reason.includes("not installed"))).toBe(true);
  });

  it("falls back when exactModelId is not in the registry", () => {
    const result = chooseModel(ctx({ exactModelId: "nonexistent-model-id" }));
    expect(result.rejectedCandidates.some((r) => r.reason.includes("not in the registry"))).toBe(true);
  });
});

describe("chooseModel — result shape", () => {
  it("returns structured resolvedMode with reason", () => {
    const result = chooseModel(ctx({ mode: "balanced" }));
    expect(result.resolvedMode.mode).toBe("balanced");
    expect(typeof result.resolvedMode.reason).toBe("string");
  });

  it("returns selectionReasons array", () => {
    const result = chooseModel(ctx());
    expect(Array.isArray(result.selectionReasons)).toBe(true);
    expect(result.selectionReasons.length).toBeGreaterThan(0);
  });

  it("returns fallbackCandidates as STTModelMetadata array", () => {
    const result = chooseModel(ctx());
    expect(Array.isArray(result.fallbackCandidates)).toBe(true);
  });

  it("returns appliedBiases array", () => {
    const result = chooseModel(ctx());
    expect(Array.isArray(result.appliedBiases)).toBe(true);
  });
});

describe("resolveMode", () => {
  it("passes through non-auto modes unchanged", () => {
    expect(resolveMode("fast", highEndDevice).mode).toBe("fast");
    expect(resolveMode("balanced", highEndDevice).mode).toBe("balanced");
    expect(resolveMode("best_accuracy", highEndDevice).mode).toBe("best_accuracy");
  });

  it("includes a reason for non-auto modes", () => {
    const result = resolveMode("fast", highEndDevice);
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("resolves auto to best_accuracy on high-end device with ample RAM", () => {
    expect(resolveMode("auto", highEndDevice).mode).toBe("best_accuracy");
  });

  it("resolves auto to fast when battery saver is on", () => {
    const batterySaverDevice: DeviceProfile = { ...highEndDevice, batterySaverActive: true };
    expect(resolveMode("auto", batterySaverDevice).mode).toBe("fast");
  });

  it("resolves auto to fast on low-end device", () => {
    expect(resolveMode("auto", lowEndDevice).mode).toBe("fast");
  });

  it("resolves auto to balanced on mid-tier device", () => {
    const midDevice: DeviceProfile = { ...highEndDevice, cpuTier: "mid", ramMB: 4096 };
    expect(resolveMode("auto", midDevice).mode).toBe("balanced");
  });

  it("downgrades best_accuracy to balanced on underpowered device", () => {
    const weakDevice: DeviceProfile = { ...lowEndDevice, ramMB: 512 };
    const result = resolveMode("best_accuracy", weakDevice);
    expect(result.mode).toBe("balanced");
    expect(result.reason).toContain("downgraded");
  });
});
