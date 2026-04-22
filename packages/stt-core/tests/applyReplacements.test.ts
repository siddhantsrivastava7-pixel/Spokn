import { applyReplacements } from "../src/postprocessing/applyReplacements";

describe("applyReplacements", () => {
  test("no-op when replacements is undefined", () => {
    expect(applyReplacements("hello", undefined)).toBe("hello");
  });

  test("no-op when replacements is empty", () => {
    expect(applyReplacements("hello", {})).toBe("hello");
  });

  test("replaces a whole-word case-insensitive match", () => {
    expect(applyReplacements("u and u again", { u: "you" })).toBe(
      "you and you again",
    );
  });

  test('"im" replacement does not destroy an existing "I\'m"', () => {
    // \b breaks at the apostrophe so "im" inside "I'm" is not a whole word.
    expect(applyReplacements("I'm leaving", { im: "I'm" })).toBe("I'm leaving");
  });

  test('"im" at word position becomes "I\'m"', () => {
    expect(applyReplacements("im leaving now", { im: "I'm" })).toBe("I'm leaving now");
  });

  test("does not match inside longer words", () => {
    // "u" must not match inside "used".
    expect(applyReplacements("i used it", { u: "you" })).toBe("i used it");
  });

  test("preserves replacement value casing verbatim", () => {
    expect(applyReplacements("U", { u: "you" })).toBe("you");
    expect(applyReplacements("i like JS", { js: "JavaScript" })).toBe(
      "i like JavaScript",
    );
  });

  test("idempotent on already-applied text", () => {
    const rules = { u: "you", im: "I'm" };
    const first = applyReplacements("im telling u", rules);
    const second = applyReplacements(first, rules);
    expect(second).toBe(first);
  });

  test("picks the longest key first when keys overlap", () => {
    const rules = { you: "u", "you know": "yk" };
    expect(applyReplacements("you know what", rules)).toBe("yk what");
  });
});
