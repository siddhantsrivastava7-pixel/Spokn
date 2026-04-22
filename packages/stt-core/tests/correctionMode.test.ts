import {
  budgetFor,
  resolveCorrectionMode,
} from "../src/postprocessing/correctionMode";
import type { ScoredSegment } from "../src/types";

function seg(partial: Partial<ScoredSegment>): ScoredSegment {
  return {
    startMs: 0,
    endMs: 1000,
    text: "hello",
    tier: "HIGH",
    ...partial,
  };
}

describe("resolveCorrectionMode", () => {
  test("HIGH tier → assertive", () => {
    expect(resolveCorrectionMode(seg({ tier: "HIGH" }))).toBe("assertive");
  });

  test("MEDIUM tier → neutral", () => {
    expect(resolveCorrectionMode(seg({ tier: "MEDIUM" }))).toBe("neutral");
  });

  test("LOW not reprocessed → strict", () => {
    expect(resolveCorrectionMode(seg({ tier: "LOW" }))).toBe("strict");
  });

  test("LOW but reprocessed → neutral (reprocessed text is trusted)", () => {
    expect(
      resolveCorrectionMode(seg({ tier: "LOW", reprocessed: true })),
    ).toBe("neutral");
  });
});

describe("budgetFor", () => {
  test("strict: only casing + punctuation", () => {
    expect(budgetFor("strict")).toEqual({
      allowCasing: true,
      allowPunctuation: true,
      allowFillerRemoval: false,
      allowSentenceSplit: false,
      allowRepeatedStopwordCollapse: false,
      allowContractionExpansion: false,
    });
  });

  test("neutral: adds fillers + splitting", () => {
    expect(budgetFor("neutral")).toEqual({
      allowCasing: true,
      allowPunctuation: true,
      allowFillerRemoval: true,
      allowSentenceSplit: true,
      allowRepeatedStopwordCollapse: false,
      allowContractionExpansion: false,
    });
  });

  test("assertive: adds stopword collapse + contraction expansion", () => {
    expect(budgetFor("assertive")).toEqual({
      allowCasing: true,
      allowPunctuation: true,
      allowFillerRemoval: true,
      allowSentenceSplit: true,
      allowRepeatedStopwordCollapse: true,
      allowContractionExpansion: true,
    });
  });

  test("invariant: no budget permits word insertion", () => {
    for (const mode of ["strict", "neutral", "assertive"] as const) {
      const budget = budgetFor(mode);
      expect(budget).not.toHaveProperty("allowSubjectInference");
      expect(budget).not.toHaveProperty("allowConnectorInsertion");
    }
  });
});
