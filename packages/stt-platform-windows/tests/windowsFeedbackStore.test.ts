import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { FeedbackEntry } from "@stt/core";
import { WindowsFeedbackStore } from "../src/feedback/WindowsFeedbackStore";

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stt-fb-"));
  return path.join(dir, "entries.jsonl");
}

function makeEntry(id: string, overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    id,
    recordedAt: new Date().toISOString(),
    rawText: "raw",
    formattedOutput: "formatted",
    userCorrected: "corrected",
    detectedIntent: "paragraph",
    intentConfidence: 0.7,
    corrections: [],
    ...overrides,
  };
}

describe("WindowsFeedbackStore", () => {
  test("append + list round-trip preserves order", async () => {
    const store = new WindowsFeedbackStore({ filePath: tempFile() });
    await store.append(makeEntry("a"));
    await store.append(makeEntry("b"));
    await store.append(makeEntry("c"));
    const all = await store.list();
    expect(all.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  test("list returns [] when file is missing", async () => {
    const store = new WindowsFeedbackStore({ filePath: tempFile() });
    expect(await store.list()).toEqual([]);
  });

  test("limit returns the last N entries", async () => {
    const store = new WindowsFeedbackStore({ filePath: tempFile() });
    for (const id of ["a", "b", "c", "d", "e"]) await store.append(makeEntry(id));
    const last2 = await store.list(2);
    expect(last2.map((e) => e.id)).toEqual(["d", "e"]);
  });

  test("clear removes the file", async () => {
    const fp = tempFile();
    const store = new WindowsFeedbackStore({ filePath: fp });
    await store.append(makeEntry("a"));
    await store.clear();
    expect(fs.existsSync(fp)).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  test("clear is a no-op when file absent", async () => {
    const store = new WindowsFeedbackStore({ filePath: tempFile() });
    await store.clear(); // must not throw
    expect(await store.list()).toEqual([]);
  });

  test("malformed lines are ignored, valid entries still load", async () => {
    const fp = tempFile();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const valid = JSON.stringify(makeEntry("good")) + "\n";
    const garbage = "{not json}\n\n  \n";
    fs.writeFileSync(fp, garbage + valid);
    const store = new WindowsFeedbackStore({ filePath: fp });
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe("good");
  });

  test("append is additive: second store instance sees prior writes", async () => {
    const fp = tempFile();
    const s1 = new WindowsFeedbackStore({ filePath: fp });
    await s1.append(makeEntry("a"));
    const s2 = new WindowsFeedbackStore({ filePath: fp });
    await s2.append(makeEntry("b"));
    const all = await new WindowsFeedbackStore({ filePath: fp }).list();
    expect(all.map((e) => e.id)).toEqual(["a", "b"]);
  });
});
