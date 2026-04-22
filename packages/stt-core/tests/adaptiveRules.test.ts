import { deriveAdaptiveRules } from "../src/feedback/adaptiveRules";
import type { FeedbackEntry } from "../src/feedback/feedbackTypes";

function entry(partial: Partial<FeedbackEntry>): FeedbackEntry {
  return {
    id: partial.id ?? `e-${Math.random().toString(36).slice(2, 8)}`,
    recordedAt: partial.recordedAt ?? new Date().toISOString(),
    rawText: partial.rawText ?? "raw",
    formattedOutput: partial.formattedOutput ?? "formatted",
    userCorrected: partial.userCorrected ?? "corrected",
    detectedIntent: partial.detectedIntent ?? "paragraph",
    intentConfidence: partial.intentConfidence ?? 0.7,
    corrections: partial.corrections ?? [],
    language: partial.language,
  };
}

describe("deriveAdaptiveRules", () => {
  test("empty feedback → empty rules", () => {
    const rules = deriveAdaptiveRules([]);
    expect(rules.fillerExceptions).toEqual([]);
    expect(rules.hinglishDictionaryOverrides).toEqual({});
    expect(rules.intentBias).toEqual({});
  });

  describe("filler exceptions", () => {
    const base = entry({
      rawText: "um we should ship",
      formattedOutput: "We should ship.",
      userCorrected: "Um we should ship.",
      corrections: [
        { kind: "filler", from: "um", to: "", mode: "neutral" },
      ],
    });

    test("fires only after minSupport re-insertions", () => {
      // 2 events — under default minSupport (3).
      const rules2 = deriveAdaptiveRules([base, { ...base, id: "e2" }]);
      expect(rules2.fillerExceptions).toEqual([]);
      // 3 events — hits threshold.
      const rules3 = deriveAdaptiveRules([
        base,
        { ...base, id: "e2" },
        { ...base, id: "e3" },
      ]);
      expect(rules3.fillerExceptions).toEqual(["um"]);
    });

    test("custom minSupport is honored", () => {
      const rules = deriveAdaptiveRules([base, { ...base, id: "e2" }], {
        minSupport: 2,
      });
      expect(rules.fillerExceptions).toEqual(["um"]);
    });

    test("does not fire when user removed the filler too", () => {
      const removed = entry({
        rawText: "um we should ship",
        formattedOutput: "We should ship.",
        userCorrected: "We should ship.",
        corrections: [{ kind: "filler", from: "um", to: "", mode: "neutral" }],
      });
      const rules = deriveAdaptiveRules([removed, { ...removed, id: "e2" }, { ...removed, id: "e3" }]);
      expect(rules.fillerExceptions).toEqual([]);
    });
  });

  describe("hinglish dictionary overrides", () => {
    test("consistent re-casing becomes an override", () => {
      // The pipeline delivered lowercase "raj" (no match in its dictionary), and
      // the user consistently writes it as "RAJ" — a custom casing worth learning.
      const e = entry({
        rawText: "i met raj today",
        formattedOutput: "I met raj today.",
        userCorrected: "I met RAJ today.",
      });
      const rules = deriveAdaptiveRules([e, { ...e, id: "e2" }, { ...e, id: "e3" }]);
      expect(rules.hinglishDictionaryOverrides["raj"]).toBe("RAJ");
    });

    test("strips trailing punctuation so 'Raj.' matches raw 'raj'", () => {
      const e = entry({
        rawText: "raj arrived",
        userCorrected: "RAJ arrived.",
      });
      const rules = deriveAdaptiveRules([e, { ...e, id: "e2" }, { ...e, id: "e3" }]);
      expect(rules.hinglishDictionaryOverrides["raj"]).toBe("RAJ");
    });

    test("casings below minSupport are dropped", () => {
      const a = entry({ rawText: "raj arrived", userCorrected: "Raj arrived." });
      const b = entry({ rawText: "raj left", userCorrected: "Rajat left." });
      const rules = deriveAdaptiveRules([a, b], { minSupport: 2 });
      // "Raj" (count 1) and "Rajat" (count 1) both under threshold.
      expect(rules.hinglishDictionaryOverrides["raj"]).toBeUndefined();
    });
  });

  describe("intent bias", () => {
    test("paragraph → bullet_list: positive bias on bullet_list", () => {
      const e = entry({
        detectedIntent: "paragraph",
        userCorrected: "• Milk\n• Eggs\n• Bread",
      });
      const rules = deriveAdaptiveRules([e, { ...e, id: "e2" }, { ...e, id: "e3" }]);
      expect(rules.intentBias.bullet_list).toBeGreaterThan(0);
    });

    test("bias capped at ±0.2", () => {
      const e = entry({
        detectedIntent: "paragraph",
        userCorrected: "• one\n• two",
      });
      const many = Array.from({ length: 100 }, (_, i) => ({ ...e, id: `e${i}` }));
      const rules = deriveAdaptiveRules(many);
      expect(rules.intentBias.bullet_list).toBe(0.2);
    });

    test("list intent + user stripped markers → bias paragraph", () => {
      const e = entry({
        detectedIntent: "bullet_list",
        formattedOutput: "• a\n• b",
        userCorrected: "Just a paragraph, no bullets.",
      });
      const rules = deriveAdaptiveRules([e, { ...e, id: "e2" }, { ...e, id: "e3" }]);
      expect(rules.intentBias.paragraph).toBeGreaterThan(0);
    });
  });

  test("pure function: same inputs → same output", () => {
    const e = entry({
      rawText: "um we should ship",
      userCorrected: "Um we should ship.",
      corrections: [{ kind: "filler", from: "um", to: "", mode: "neutral" }],
    });
    const inputs = [e, { ...e, id: "e2" }, { ...e, id: "e3" }];
    const a = deriveAdaptiveRules(inputs);
    const b = deriveAdaptiveRules(inputs);
    expect(a).toEqual(b);
  });
});
