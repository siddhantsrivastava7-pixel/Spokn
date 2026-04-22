import * as path from "path";
import { getAppDataRoot, getModelsDir, getModelDir, getBinDir, sanitizeModelId } from "../src/utils/pathUtils";

describe("pathUtils", () => {
  const originalEnv = process.env["LOCALAPPDATA"];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env["LOCALAPPDATA"] = originalEnv;
    } else {
      delete process.env["LOCALAPPDATA"];
    }
  });

  it("uses LOCALAPPDATA env var", () => {
    process.env["LOCALAPPDATA"] = "C:\\Users\\test\\AppData\\Local";
    expect(getAppDataRoot()).toBe(
      path.join("C:\\Users\\test\\AppData\\Local", "stt-platform-windows")
    );
  });

  it("models dir is inside app data root", () => {
    expect(getModelsDir()).toContain("models");
    expect(getModelsDir()).toContain("stt-platform-windows");
  });

  it("model dir includes sanitized model id", () => {
    const dir = getModelDir("whisper-turbo");
    expect(dir).toContain("whisper-turbo");
  });

  it("bin dir is inside app data root", () => {
    expect(getBinDir()).toContain("bin");
    expect(getBinDir()).toContain("stt-platform-windows");
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
