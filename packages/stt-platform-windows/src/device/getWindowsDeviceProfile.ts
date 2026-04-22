import * as os from "os";
import { execProcess } from "../utils/execProcess";
import { hasCudaRuntime } from "../binary/binaryManager";
import type { DeviceProfile, CpuTier, GpuVendor } from "@stt/core";

/**
 * Returns a DeviceProfile for the current Windows machine.
 * Uses os module for fast baseline values; augments with wmic for CPU tier.
 */
export async function getWindowsDeviceProfile(): Promise<DeviceProfile> {
  const ramMB = Math.round(os.totalmem() / (1024 * 1024));
  const [cpuTier, storageAvailableMB, batterySaverActive, gpu, cudaRuntimeAvailable] = await Promise.all([
    detectCpuTier(),
    getStorageAvailableMB(),
    isBatterySaverActive(),
    detectGpu(),
    hasCudaRuntime(),
  ]);

  return {
    platform: "windows",
    cpuTier,
    ramMB,
    storageAvailableMB,
    batterySaverActive,
    lowPowerMode: batterySaverActive,
    hasGpu: gpu.hasGpu,
    gpuVendor: gpu.vendor,
    gpuVramMB: gpu.vramMB,
    cudaRuntimeAvailable,
    osVersion: os.release(),
  };
}

async function detectCpuTier(): Promise<CpuTier> {
  try {
    const cpus = os.cpus();
    const logicalCores = cpus.length;
    const speedMHz = cpus[0]?.speed ?? 0;

    // 16+ logical cores is unambiguously high-end regardless of reported speed
    if (logicalCores >= 16) return "high";
    // Windows often reports speed as 0 — fall back to core count alone
    if (logicalCores >= 8 && speedMHz >= 2500) return "high";
    if (logicalCores >= 8 && speedMHz === 0) return "high";
    if (logicalCores >= 4 && speedMHz >= 1800) return "mid";
    if (logicalCores >= 4 && speedMHz === 0) return "mid";
    return "low";
  } catch {
    return "mid";
  }
}

async function getStorageAvailableMB(): Promise<number> {
  try {
    // wmic logicaldisk get FreeSpace for C: drive
    const result = await execProcess("wmic", [
      "logicaldisk",
      "where",
      "DeviceID='C:'",
      "get",
      "FreeSpace",
      "/value",
    ]);
    const match = result.stdout.match(/FreeSpace=(\d+)/);
    if (match?.[1]) {
      return Math.round(Number(match[1]) / (1024 * 1024));
    }
  } catch {
    // wmic may not be available on all Windows editions
  }

  // Fallback: assume 10 GB free
  return 10_240;
}

interface GpuInfo {
  hasGpu: boolean;
  vendor: GpuVendor;
  vramMB: number;
}

async function detectGpu(): Promise<GpuInfo> {
  const fallback: GpuInfo = { hasGpu: false, vendor: "unknown", vramMB: 0 };
  try {
    const result = await execProcess("wmic", [
      "path", "win32_VideoController",
      "get", "Name,AdapterRAM,VideoProcessor",
      "/value",
    ]);

    const lines = result.stdout;

    // Parse all GPU entries (wmic returns one block per adapter)
    const nameMatches = [...lines.matchAll(/Name=(.+)/g)].map((m) => m[1]?.trim() ?? "");
    const vramMatches = [...lines.matchAll(/AdapterRAM=(\d+)/g)].map((m) => Number(m[1] ?? 0));

    // Find the best dedicated GPU (prefer NVIDIA > AMD > anything else, skip pure Intel integrated)
    let best: GpuInfo = fallback;

    for (let i = 0; i < nameMatches.length; i++) {
      const name = nameMatches[i]?.toLowerCase() ?? "";
      const vramMB = Math.round((vramMatches[i] ?? 0) / (1024 * 1024));

      let vendor: GpuVendor = "unknown";
      if (name.includes("nvidia") || name.includes("geforce") || name.includes("quadro") || name.includes("rtx") || name.includes("gtx")) {
        vendor = "nvidia";
      } else if (name.includes("amd") || name.includes("radeon") || name.includes("rx ")) {
        vendor = "amd";
      } else if (name.includes("intel")) {
        vendor = "intel";
      }

      // Skip Intel integrated if we already found something better
      const isDedicated = vendor === "nvidia" || vendor === "amd";
      if (isDedicated && vramMB > best.vramMB) {
        best = { hasGpu: true, vendor, vramMB };
      } else if (!best.hasGpu && vendor !== "intel" && vramMB > 0) {
        best = { hasGpu: true, vendor, vramMB };
      }
    }

    return best;
  } catch {
    return fallback;
  }
}

async function isBatterySaverActive(): Promise<boolean> {
  try {
    const result = await execProcess("powercfg", ["/query", "SCHEME_CURRENT"]);
    // Battery saver mode activates the "Power Saver" scheme
    return result.stdout.toLowerCase().includes("power saver");
  } catch {
    return false;
  }
}
