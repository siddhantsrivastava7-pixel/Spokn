import { detectIntentHybrid } from "../src/postprocessing/intentDetection";
import type { TranscriptSegment } from "../src/types";

const seg = (text: string, startMs: number, endMs: number): TranscriptSegment => ({
  text,
  startMs,
  endMs,
});

describe("detectIntentHybrid", () => {
  test("empty text → NOTE", () => {
    expect(detectIntentHybrid([], "")).toEqual({ primary: "NOTE" });
  });

  test('"buy milk, eggs and call mom" → LIST primary, COMMAND secondary', () => {
    const text = "buy milk, eggs and call mom";
    const r = detectIntentHybrid([seg(text, 0, 3000)], text);
    expect(r.primary).toBe("LIST");
    expect(r.secondary).toBe("COMMAND");
  });

  test("plain command without list markers → COMMAND only", () => {
    const text = "send an email to alex";
    const r = detectIntentHybrid([seg(text, 0, 2000)], text);
    expect(r.primary).toBe("COMMAND");
    expect(r.secondary).toBeUndefined();
  });

  test("pure list (multi-seg short) → LIST only, no COMMAND", () => {
    const segs = [
      seg("eggs", 0, 500),
      seg("milk", 900, 1300),
      seg("bread", 1700, 2100),
    ];
    const r = detectIntentHybrid(segs, "eggs milk bread");
    expect(r.primary).toBe("LIST");
    expect(r.secondary).toBeUndefined();
  });

  test("long comma-rich paragraph does NOT get promoted to LIST", () => {
    // Above the 20-word hybrid cap; commas inside a long paragraph shouldn't flip it.
    const text =
      "the quarterly review covered performance, customer feedback, engineering progress, and the upcoming product launch that leadership has been discussing for weeks now";
    const r = detectIntentHybrid([seg(text, 0, 8000)], text);
    expect(r.primary).not.toBe("LIST");
  });

  test("comma chain with only comma + and → LIST", () => {
    const text = "apples, oranges and pears";
    const r = detectIntentHybrid([seg(text, 0, 1500)], text);
    expect(r.primary).toBe("LIST");
  });

  test("explicit list keyword beats single-verb start", () => {
    const text = "my shopping list apples oranges pears";
    const r = detectIntentHybrid([seg(text, 0, 2000)], text);
    expect(r.primary).toBe("LIST");
  });
});
