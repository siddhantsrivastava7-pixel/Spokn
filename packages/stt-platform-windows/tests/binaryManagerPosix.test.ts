// Verifies the macOS/Linux probe path in binaryManager.ensureBinary:
//   - never attempts a download
//   - never writes a .exe binary or a Windows-shaped manifest
//   - returns the WHISPER_CPP_BIN override when set
//   - throws BackendBinaryMissingError with a useful message when nothing
//     is available
//
// These tests are POSIX-only; the Windows download path has its own
// separate coverage and we don't want a macOS test run to hit GitHub.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { DeviceProfile } from "@stt/core";

const describePosix = process.platform !== "win32" ? describe : describe.skip;

const PROFILE: DeviceProfile = {
  platform: "macos",
  cpuTier: "mid",
  ramMB: 16_384,
  storageAvailableMB: 102_400,
  batterySaverActive: false,
  lowPowerMode: false,
  hasGpu: true,
  gpuVendor: "apple",
  gpuVramMB: 0,
  cudaRuntimeAvailable: false,
  osVersion: "25.0",
};

describePosix("binaryManager.ensureBinary (POSIX)", () => {
  const originalDataRoot = process.env["STT_DATA_ROOT"];
  const originalWhisperBin = process.env["WHISPER_CPP_BIN"];
  const originalBundled = process.env["SPOKN_BUNDLED_WHISPER_CLI"];
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stt-bm-"));
    process.env["STT_DATA_ROOT"] = tempRoot;
    delete process.env["WHISPER_CPP_BIN"];
    delete process.env["SPOKN_BUNDLED_WHISPER_CLI"];
    jest.resetModules();
  });

  afterEach(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
    if (originalDataRoot !== undefined) process.env["STT_DATA_ROOT"] = originalDataRoot;
    else delete process.env["STT_DATA_ROOT"];
    if (originalWhisperBin !== undefined) process.env["WHISPER_CPP_BIN"] = originalWhisperBin;
    else delete process.env["WHISPER_CPP_BIN"];
    if (originalBundled !== undefined) process.env["SPOKN_BUNDLED_WHISPER_CLI"] = originalBundled;
    else delete process.env["SPOKN_BUNDLED_WHISPER_CLI"];
  });

  it("returns the WHISPER_CPP_BIN override when the file exists", async () => {
    const fakeBinary = path.join(tempRoot, "whisper-cli");
    await fs.promises.writeFile(fakeBinary, "#!/bin/sh\necho fake\n", { mode: 0o755 });
    process.env["WHISPER_CPP_BIN"] = fakeBinary;

    // Re-require to pick up env changes (ensureBinary imports getBinDir/etc.)
    const { ensureBinary: reloaded } = await import("../src/binary/binaryManager");
    const result = await reloaded(PROFILE);

    expect(result.binaryPath).toBe(fakeBinary);
    expect(result.variant).toBe("cpu");
    expect(result.binaryPath.endsWith(".exe")).toBe(false);
  });

  it("SPOKN_BUNDLED_WHISPER_CLI wins over WHISPER_CPP_BIN and managed bin dir", async () => {
    // Set up all three candidate locations, each pointing at a different file.
    // The bundled one must be chosen — this is what a signed macOS install
    // does at runtime, and we never want a system binary to take over.
    const bundled = path.join(tempRoot, "bundled-whisper-cli");
    const override = path.join(tempRoot, "override-whisper-cli");
    const binDir = path.join(tempRoot, "bin");
    await fs.promises.mkdir(binDir, { recursive: true });
    const managed = path.join(binDir, "whisper-cli");

    for (const p of [bundled, override, managed]) {
      await fs.promises.writeFile(p, "#!/bin/sh\n", { mode: 0o755 });
    }

    process.env["SPOKN_BUNDLED_WHISPER_CLI"] = bundled;
    process.env["WHISPER_CPP_BIN"] = override;

    const { ensureBinary: reloaded } = await import("../src/binary/binaryManager");
    const result = await reloaded(PROFILE);
    expect(result.binaryPath).toBe(bundled);
  });

  it("falls through to WHISPER_CPP_BIN when SPOKN_BUNDLED_WHISPER_CLI points at a nonexistent file", async () => {
    // The env var might be set (e.g. leftover from a stale shell) but the
    // file might be gone. We should cleanly fall back, not throw.
    const override = path.join(tempRoot, "override-whisper-cli");
    await fs.promises.writeFile(override, "#!/bin/sh\n", { mode: 0o755 });
    process.env["SPOKN_BUNDLED_WHISPER_CLI"] = path.join(tempRoot, "nope");
    process.env["WHISPER_CPP_BIN"] = override;

    const { ensureBinary: reloaded } = await import("../src/binary/binaryManager");
    const result = await reloaded(PROFILE);
    expect(result.binaryPath).toBe(override);
  });

  it("finds a binary dropped into the managed bin dir", async () => {
    const binDir = path.join(tempRoot, "bin");
    await fs.promises.mkdir(binDir, { recursive: true });
    const fakeBinary = path.join(binDir, "whisper-cli");
    await fs.promises.writeFile(fakeBinary, "#!/bin/sh\necho fake\n", { mode: 0o755 });

    const { ensureBinary: reloaded } = await import("../src/binary/binaryManager");
    const result = await reloaded(PROFILE);

    expect(result.binaryPath).toBe(fakeBinary);
    expect(result.variant).toBe("cpu");
  });

  it("throws BackendBinaryMissingError with install instructions when nothing is found", async () => {
    // HOMEBREW_PREFIX could resolve to an installed whisper-cli on a dev
    // machine — null it out so this test is deterministic.
    const prevBrew = process.env["HOMEBREW_PREFIX"];
    delete process.env["HOMEBREW_PREFIX"];

    // Also isolate from real /opt/homebrew and /usr/local — we can't delete
    // those, so the assertion tolerates their presence. If whisper-cli
    // happens to be installed via Homebrew on this machine, skip the miss
    // case (we already cover the "found" branch above).
    const realHits =
      fs.existsSync("/opt/homebrew/bin/whisper-cli") ||
      fs.existsSync("/usr/local/bin/whisper-cli");
    if (realHits) {
      if (prevBrew !== undefined) process.env["HOMEBREW_PREFIX"] = prevBrew;
      return;
    }

    // NB: we check the error *name* + *message* rather than `instanceof`
    // because `jest.resetModules()` in beforeEach reloads the error class,
    // so class identity across the static import and the dynamic import
    // doesn't match. Behaviourally, what the caller cares about is the
    // error identity via `.name` and the install-hint text.
    const { ensureBinary: reloaded } = await import("../src/binary/binaryManager");
    let caught: Error | null = null;
    try {
      await reloaded(PROFILE);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.name).toBe("BackendBinaryMissingError");
    expect(caught?.message).toContain("whisper-cli was not found");
    expect(caught?.message).toContain("WHISPER_CPP_BIN");

    if (prevBrew !== undefined) process.env["HOMEBREW_PREFIX"] = prevBrew;
  });
});
