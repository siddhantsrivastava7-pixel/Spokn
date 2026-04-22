import { deriveReplacementRules } from "../src/feedback/userCorrections";

describe("deriveReplacementRules", () => {
  test("returns {} on empty input", () => {
    expect(deriveReplacementRules([])).toEqual({});
  });

  test("drops pairs below minSupport (default 2)", () => {
    expect(
      deriveReplacementRules([{ original: "Whisper", corrected: "Wispr" }]),
    ).toEqual({});
  });

  test("promotes a pair that repeats at or above minSupport", () => {
    expect(
      deriveReplacementRules([
        { original: "Whisper", corrected: "Wispr" },
        { original: "Whisper", corrected: "Wispr" },
      ]),
    ).toEqual({ whisper: "Wispr" });
  });

  test("lowercases the key but keeps the replacement as entered", () => {
    expect(
      deriveReplacementRules([
        { original: "Siddharth", corrected: "Sid" },
        { original: "siddharth", corrected: "Sid" },
        { original: "SIDDHARTH", corrected: "Sid" },
      ]),
    ).toEqual({ siddharth: "Sid" });
  });

  test("chooses the most frequent replacement when multiple candidates compete", () => {
    const rules = deriveReplacementRules([
      { original: "JS", corrected: "JavaScript" },
      { original: "JS", corrected: "JavaScript" },
      { original: "JS", corrected: "JavaScript" },
      { original: "JS", corrected: "javascript" },
      { original: "JS", corrected: "javascript" },
    ]);
    expect(rules).toEqual({ js: "JavaScript" });
  });

  test("ignores identity corrections (case-insensitive)", () => {
    expect(
      deriveReplacementRules([
        { original: "hello", corrected: "Hello" },
        { original: "hello", corrected: "Hello" },
      ]),
    ).toEqual({});
  });

  test("honors a custom minSupport", () => {
    expect(
      deriveReplacementRules(
        [{ original: "Whisper", corrected: "Wispr" }],
        { minSupport: 1 },
      ),
    ).toEqual({ whisper: "Wispr" });
  });

  test("ignores blank originals or replacements", () => {
    expect(
      deriveReplacementRules([
        { original: "", corrected: "Wispr" },
        { original: "Whisper", corrected: "   " },
      ]),
    ).toEqual({});
  });
});
