import { processTranscript } from "../src/postprocessing/processTranscript";
import type { ScoredSegment } from "../src/types";

function seg(overrides: Partial<ScoredSegment> & { text: string }): ScoredSegment {
  return {
    startMs: 0,
    endMs: 1000,
    tier: "HIGH",
    normalizedConfidence: 0.9,
    confidenceLevel: "HIGH",
    ...overrides,
  } as ScoredSegment;
}

describe("processTranscript — adaptiveRules.replacements", () => {
  test("applies replacements before downstream stages see the text", () => {
    const segments = [
      seg({ text: "u need to review", startMs: 0, endMs: 2000 }),
      seg({ text: "im heading out", startMs: 2100, endMs: 4000 }),
    ];
    const result = processTranscript({
      text: "u need to review im heading out",
      segments,
      language: "en",
      adaptiveRules: {
        replacements: { u: "you", im: "I'm" },
      },
    });

    // correctedText should reflect replacements.
    expect(result.correctedText.toLowerCase()).toContain("you");
    expect(result.correctedText).toContain("I'm");
    // rawText must be preserved untouched.
    expect(result.rawText).toBe("u need to review im heading out");
  });

  test("no replacements → behavior is unchanged", () => {
    const segments = [seg({ text: "the report looks good to me", startMs: 0, endMs: 2500 })];
    const withoutRules = processTranscript({
      text: "the report looks good to me",
      segments,
      language: "en",
    });
    const withEmptyRules = processTranscript({
      text: "the report looks good to me",
      segments,
      language: "en",
      adaptiveRules: { replacements: {} },
    });
    expect(withEmptyRules.correctedText).toBe(withoutRules.correctedText);
  });

  test("segment-level text also reflects replacements in formattedText path", () => {
    const segments = [
      seg({ text: "u finished the draft", startMs: 0, endMs: 1500 }),
      seg({ text: "im about to send it", startMs: 2500, endMs: 4000 }),
    ];
    const result = processTranscript({
      text: "u finished the draft im about to send it",
      segments,
      language: "en",
      adaptiveRules: { replacements: { u: "you", im: "I'm" } },
    });
    // formattedText is built from segments + correctedText; both paths
    // should have seen the replaced tokens.
    const f = (result.formattedText ?? "").toLowerCase();
    expect(f).toContain("you");
    expect(f).toContain("i'm");
  });
});
