import * as path from "path";
import * as os from "os";
import { getAppDataRoot, getModelsDir, getModelDir, getBinDir, sanitizeModelId } from "../src/utils/pathUtils";

// These tests exercise the platform-aware resolver without invoking
// `process.platform` rewrites — instead they use the explicit
// `STT_DATA_ROOT` override for deterministic assertions, and conditional
// `platform`-branch tests where the underlying path shape is the thing
// under test.

describe("pathUtils", () => {
  const originalDataRoot = process.env["STT_DATA_ROOT"];
  const originalLocalAppData = process.env["LOCALAPPDATA"];

  afterEach(() => {
    if (originalDataRoot !== undefined) {
      process.env["STT_DATA_ROOT"] = originalDataRoot;
    } else {
      delete process.env["STT_DATA_ROOT"];
    }
    if (originalLocalAppData !== undefined) {
      process.env["LOCALAPPDATA"] = originalLocalAppData;
    } else {
      delete process.env["LOCALAPPDATA"];
    }
  });

  it("honors the STT_DATA_ROOT override regardless of platform", () => {
    process.env["STT_DATA_ROOT"] = "/tmp/forced-root";
    expect(getAppDataRoot()).toBe("/tmp/forced-root");
  });

  it("models dir is inside app data root", () => {
    process.env["STT_DATA_ROOT"] = "/tmp/root";
    expect(getModelsDir()).toBe(path.join("/tmp/root", "models"));
  });

  it("model dir includes sanitized model id", () => {
    process.env["STT_DATA_ROOT"] = "/tmp/root";
    expect(getModelDir("whisper-turbo")).toBe(
      path.join("/tmp/root", "models", "whisper-turbo")
    );
  });

  it("bin dir is inside app data root", () => {
    process.env["STT_DATA_ROOT"] = "/tmp/root";
    expect(getBinDir()).toBe(path.join("/tmp/root", "bin"));
  });

  describe("platform-native resolution", () => {
    beforeEach(() => {
      delete process.env["STT_DATA_ROOT"];
    });

    if (process.platform === "win32") {
      it("uses LOCALAPPDATA + stt-platform-windows on Windows", () => {
        process.env["LOCALAPPDATA"] = "C:\\Users\\test\\AppData\\Local";
        expect(getAppDataRoot()).toBe(
          path.join("C:\\Users\\test\\AppData\\Local", "stt-platform-windows")
        );
      });
    }

    if (process.platform === "darwin") {
      it("uses ~/Library/Application Support/spokn on macOS", () => {
        expect(getAppDataRoot()).toBe(
          path.join(os.homedir(), "Library", "Application Support", "spokn")
        );
      });

      it("macOS paths do NOT contain Windows-shaped fragments", () => {
        const root = getAppDataRoot();
        expect(root).not.toContain("AppData");
        expect(root).not.toContain("stt-platform-windows");
      });
    }
  });

  describe("sanitizeModelId", () => {
    it("allows alphanumeric, dots, dashes, underscores", () => {
      expect(sanitizeModelId("whisper-turbo.v2_fast")).toBe("whisper-turbo.v2_fast");
    });

    it("replaces unsafe characters with underscores", () => {
      expect(sanitizeModelId("model/with/slash")).toBe("model_with_slash");
      expect(sanitizeModelId("model with space")).toBe("model_with_space");
    });
  });
});
