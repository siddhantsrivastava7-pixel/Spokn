// Runs only on macOS — the device profiler shells out to `sysctl` / `df`
// / `pmset`, which don't exist on Windows/Linux. On other platforms we
// skip rather than mock, because the value being verified is the real
// sysctl response.

import { getMacOSDeviceProfile } from "../src/device/getMacOSDeviceProfile";

const describeMac = process.platform === "darwin" ? describe : describe.skip;

describeMac("getMacOSDeviceProfile (macOS-only)", () => {
  it("reports platform: macos", async () => {
    const profile = await getMacOSDeviceProfile();
    expect(profile.platform).toBe("macos");
  });

  it("never reports platform: windows", async () => {
    const profile = await getMacOSDeviceProfile();
    expect(profile.platform).not.toBe("windows");
  });

  it("never reports CUDA as available", async () => {
    const profile = await getMacOSDeviceProfile();
    expect(profile.cudaRuntimeAvailable).toBe(false);
  });

  it("returns a positive RAM estimate", async () => {
    const profile = await getMacOSDeviceProfile();
    expect(profile.ramMB).toBeGreaterThan(0);
  });

  it("returns a valid CPU tier", async () => {
    const profile = await getMacOSDeviceProfile();
    expect(["low", "mid", "high"]).toContain(profile.cpuTier);
  });

  it("reports a supported GPU vendor — never 'unknown' on modern Macs", async () => {
    const profile = await getMacOSDeviceProfile();
    expect(["apple", "intel", "amd"]).toContain(profile.gpuVendor);
  });
});
