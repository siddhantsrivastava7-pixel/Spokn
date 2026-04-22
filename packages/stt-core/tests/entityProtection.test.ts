import {
  protectionMask,
  tokenize,
  isProtected,
} from "../src/postprocessing/entityProtection";

function wordIndices(tokens: ReturnType<typeof tokenize>): number[] {
  return tokens
    .map((t, i) => (t.isSeparator ? -1 : i))
    .filter((i) => i >= 0);
}

describe("entityProtection", () => {
  test("tokenize preserves the exact string via start/end spans", () => {
    const text = "I owe $5.00 to bob@example.com.";
    const tokens = tokenize(text);
    expect(tokens.map((t) => t.text).join("")).toBe(text);
  });

  test("numbers are protected", () => {
    const tokens = tokenize("I owe 5 dollars");
    const mask = protectionMask(tokens);
    const n = tokens.findIndex((t) => t.text === "5");
    expect(mask[n]).toBe(true);
  });

  test("emails are protected", () => {
    const tokens = tokenize("email bob@example.com now");
    const mask = protectionMask(tokens);
    const e = tokens.findIndex((t) => t.text === "bob@example.com");
    expect(mask[e]).toBe(true);
  });

  test("URLs are protected", () => {
    const tokens = tokenize("visit https://example.com today");
    const mask = protectionMask(tokens);
    const u = tokens.findIndex((t) => t.text === "https://example.com");
    expect(mask[u]).toBe(true);
  });

  test("mid-sentence capitalized tokens are protected", () => {
    const tokens = tokenize("i met Priya today");
    const mask = protectionMask(tokens);
    const p = tokens.findIndex((t) => t.text === "Priya");
    expect(mask[p]).toBe(true);
  });

  test("first-word capitalization is NOT protected (sentence start)", () => {
    const tokens = tokenize("Priya arrived");
    const mask = protectionMask(tokens);
    const p = tokens.findIndex((t) => t.text === "Priya");
    expect(mask[p]).toBe(false);
  });

  test("days and months are exempt from proper-noun protection", () => {
    const tokens = tokenize("we ship Friday");
    const mask = protectionMask(tokens);
    const idx = tokens.findIndex((t) => t.text === "Friday");
    expect(mask[idx]).toBe(false);
  });

  test("isProtected: single-letter tokens never protected", () => {
    const tokens = tokenize("a b c");
    const indices = wordIndices(tokens);
    for (const i of indices) {
      expect(isProtected(tokens[i]!, i - 1)).toBe(false);
    }
  });
});
