import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { WindowsModelStore } from "../src/models/WindowsModelStore";

// Redirect LOCALAPPDATA to a temp dir for isolation
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stt-test-"));
  process.env["LOCALAPPDATA"] = tempRoot;
  // Re-require pathUtils so it picks up the new env var
  jest.resetModules();
});

afterEach(async () => {
  await fs.promises.rm(tempRoot, { recursive: true, force: true });
});

describe("WindowsModelStore", () => {
  function makeStore(): WindowsModelStore {
    return new WindowsModelStore();
  }

  it("lists no installed models when fresh", async () => {
    const store = makeStore();
    expect(await store.listInstalledModels()).toHaveLength(0);
  });

  it("isInstalled returns false for unknown model", async () => {
    const store = makeStore();
    expect(await store.isInstalled("whisper-turbo")).toBe(false);
  });

  it("registers a model and detects it as installed", async () => {
    const store = makeStore();

    // Create a fake model file
    const modelDir = path.join(tempRoot, "stt-platform-windows", "models", "whisper-turbo");
    await fs.promises.mkdir(modelDir, { recursive: true });
    const fakeModel = path.join(modelDir, "ggml-whisper-turbo.gguf");
    await fs.promises.writeFile(fakeModel, Buffer.alloc(1024));

    await store.registerModel("whisper-turbo", fakeModel, "Whisper Turbo");
    expect(await store.isInstalled("whisper-turbo")).toBe(true);
  });

  it("lists installed models after registration", async () => {
    const store = makeStore();
    const modelDir = path.join(tempRoot, "stt-platform-windows", "models", "whisper-turbo");
    await fs.promises.mkdir(modelDir, { recursive: true });
    const fakeModel = path.join(modelDir, "ggml-whisper-turbo.gguf");
    await fs.promises.writeFile(fakeModel, Buffer.alloc(1024));

    await store.registerModel("whisper-turbo", fakeModel);
    const list = await store.listInstalledModels();
    expect(list).toHaveLength(1);
    expect(list[0]?.modelId).toBe("whisper-turbo");
  });

  it("unregisters a model", async () => {
    const store = makeStore();
    const modelDir = path.join(tempRoot, "stt-platform-windows", "models", "whisper-turbo");
    await fs.promises.mkdir(modelDir, { recursive: true });
    const fakeModel = path.join(modelDir, "ggml-whisper-turbo.gguf");
    await fs.promises.writeFile(fakeModel, Buffer.alloc(1024));

    await store.registerModel("whisper-turbo", fakeModel);
    await store.unregisterModel("whisper-turbo");
    expect(await store.isInstalled("whisper-turbo")).toBe(false);
  });

  it("filters out models whose files have been deleted", async () => {
    const store = makeStore();
    const modelDir = path.join(tempRoot, "stt-platform-windows", "models", "whisper-turbo");
    await fs.promises.mkdir(modelDir, { recursive: true });
    const fakeModel = path.join(modelDir, "ggml-whisper-turbo.gguf");
    await fs.promises.writeFile(fakeModel, Buffer.alloc(1024));

    await store.registerModel("whisper-turbo", fakeModel);
    // Delete the file externally
    await fs.promises.unlink(fakeModel);
    store.invalidateCache();

    expect(await store.listInstalledModels()).toHaveLength(0);
  });
});
