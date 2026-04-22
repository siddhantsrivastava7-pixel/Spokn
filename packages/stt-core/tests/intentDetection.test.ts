import { detectIntent } from "../src/postprocessing/intentDetection";
import type { TranscriptSegment } from "../src/types";

const mkSeg = (
  text: string,
  startMs: number,
  endMs: number,
): TranscriptSegment => ({ text, startMs, endMs });

describe("detectIntent (deterministic 4-way)", () => {
  test('empty transcript → "NOTE"', () => {
    expect(detectIntent([], "")).toBe("NOTE");
    expect(detectIntent([], "   ")).toBe("NOTE");
  });

  test('explicit "list" keyword promotes to LIST', () => {
    expect(
      detectIntent(
        [mkSeg("my grocery list", 0, 1000)],
        "my grocery list",
      ),
    ).toBe("LIST");
  });

  test("multiple short segments with pauses → LIST", () => {
    const segments: TranscriptSegment[] = [
      mkSeg("eggs", 0, 500),
      mkSeg("milk", 900, 1300),
      mkSeg("bread", 1700, 2100),
      mkSeg("butter", 2500, 2900),
    ];
    expect(detectIntent(segments, "eggs milk bread butter")).toBe("LIST");
  });

  test("imperative command starting with a verb → COMMAND", () => {
    expect(
      detectIntent([mkSeg("send an email to alex", 0, 2000)], "send an email to alex"),
    ).toBe("COMMAND");
    expect(
      detectIntent([mkSeg("open the project folder", 0, 2000)], "open the project folder"),
    ).toBe("COMMAND");
  });

  test("continuous long-form speech → PARAGRAPH", () => {
    const text =
      "the product roadmap for the next quarter includes several new features driven by customer feedback from the last launch";
    expect(detectIntent([mkSeg(text, 0, 7000)], text)).toBe("PARAGRAPH");
  });

  test("short non-imperative utterance defaults to NOTE", () => {
    expect(detectIntent([mkSeg("just thinking", 0, 800)], "just thinking")).toBe("NOTE");
  });

  test("LIST beats COMMAND when the keyword is present even if it starts with a verb", () => {
    expect(
      detectIntent(
        [mkSeg("buy list eggs milk bread", 0, 3000)],
        "buy list eggs milk bread",
      ),
    ).toBe("LIST");
  });

  test("repeated first-word structure across 3+ segments → LIST", () => {
    const segs = [
      mkSeg("call mom", 0, 1000),
      mkSeg("call dad", 1200, 2200),
      mkSeg("call the doctor", 2400, 3500),
    ];
    expect(detectIntent(segs, "call mom call dad call the doctor")).toBe("LIST");
  });

  test("very short average words per segment → LIST even without pauses", () => {
    const segs = [
      mkSeg("eggs", 0, 400),
      mkSeg("milk", 401, 800),
      mkSeg("bread", 801, 1200),
      mkSeg("butter", 1201, 1600),
    ];
    expect(detectIntent(segs, "eggs milk bread butter")).toBe("LIST");
  });

  test("moderate pauses + shortish avg → LIST", () => {
    // avg 5-6 words/seg, pauses between most
    const segs = [
      mkSeg("first point to remember", 0, 1400),
      mkSeg("second idea worth trying", 1800, 3100),
      mkSeg("third outcome to verify", 3500, 4900),
    ];
    expect(
      detectIntent(segs, "first point to remember second idea worth trying third outcome to verify"),
    ).toBe("LIST");
  });

  test("long continuous speech with low pauses → PARAGRAPH", () => {
    const text = "the product roadmap for the next quarter includes several new features driven by customer feedback";
    expect(detectIntent([mkSeg(text, 0, 7000)], text)).toBe("PARAGRAPH");
  });
});
