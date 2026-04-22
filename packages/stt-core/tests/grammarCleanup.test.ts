import {
  protectionMask,
  tokenize,
} from "../src/postprocessing/entityProtection";
import { budgetFor } from "../src/postprocessing/correctionMode";
import { cleanupGrammar } from "../src/postprocessing/grammarCleanup";

function render(tokens: ReturnType<typeof tokenize>): string {
  return tokens
    .map((t) => t.text)
    .join("")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

describe("cleanupGrammar", () => {
  test("capitalizes sentence starts", () => {
    const tokens = tokenize("we should ship");
    const mask = protectionMask(tokens);
    const { tokens: out } = cleanupGrammar(tokens, mask, {
      budget: budgetFor("neutral"),
      mode: "neutral",
    });
    expect(render(out).startsWith("We should ship")).toBe(true);
  });

  test("adds terminal punctuation when missing", () => {
    const tokens = tokenize("we should ship");
    const mask = protectionMask(tokens);
    const { tokens: out, corrections } = cleanupGrammar(tokens, mask, {
      budget: budgetFor("neutral"),
      mode: "neutral",
    });
    expect(render(out).endsWith(".")).toBe(true);
    expect(corrections.some((c) => c.kind === "punctuation")).toBe(true);
  });

  test("removes always-fillers (uh, um)", () => {
    const tokens = tokenize("um we uh should ship");
    const mask = protectionMask(tokens);
    const { tokens: out, corrections } = cleanupGrammar(tokens, mask, {
      budget: budgetFor("neutral"),
      mode: "neutral",
    });
    const r = render(out);
    expect(r).not.toMatch(/\bum\b/i);
    expect(r).not.toMatch(/\buh\b/i);
    expect(corrections.filter((c) => c.kind === "filler")).toHaveLength(2);
  });

  test("preserves meaningful 'like' after a blocking verb", () => {
    const tokens = tokenize("this looks like a bug");
    const mask = protectionMask(tokens);
    const { tokens: out } = cleanupGrammar(tokens, mask, {
      budget: budgetFor("neutral"),
      mode: "neutral",
    });
    expect(render(out)).toContain("like");
  });

  test("removes contextual 'like' when it's a filler", () => {
    const tokens = tokenize("we were like going there");
    const mask = protectionMask(tokens);
    const { tokens: out } = cleanupGrammar(tokens, mask, {
      budget: budgetFor("neutral"),
      mode: "neutral",
    });
    expect(render(out)).not.toContain("like");
  });

  test('removes "you know" when not followed by a meaningful word', () => {
    const tokens = tokenize("we are you know going home");
    const mask = protectionMask(tokens);
    const { tokens: out } = cleanupGrammar(tokens, mask, {
      budget: budgetFor("neutral"),
      mode: "neutral",
    });
    expect(render(out).toLowerCase()).not.toContain("you know");
  });

  test('preserves "you know what" as meaningful', () => {
    const tokens = tokenize("you know what i mean");
    const mask = protectionMask(tokens);
    const { tokens: out } = cleanupGrammar(tokens, mask, {
      budget: budgetFor("neutral"),
      mode: "neutral",
    });
    expect(render(out).toLowerCase()).toContain("you know what");
  });

  test("strict budget: no filler removal", () => {
    const tokens = tokenize("um we should ship");
    const mask = protectionMask(tokens);
    const { tokens: out, corrections } = cleanupGrammar(tokens, mask, {
      budget: budgetFor("strict"),
      mode: "strict",
    });
    expect(render(out).toLowerCase()).toContain("um");
    expect(corrections.some((c) => c.kind === "filler")).toBe(false);
  });

  test("assertive budget: collapses repeated stopword", () => {
    const tokens = tokenize("the the report is ready");
    const mask = protectionMask(tokens);
    const { tokens: out, corrections } = cleanupGrammar(tokens, mask, {
      budget: budgetFor("assertive"),
      mode: "assertive",
    });
    expect(render(out).toLowerCase()).toContain("the report");
    expect(render(out).toLowerCase()).not.toContain("the the");
    expect(corrections.some((c) => c.kind === "stopword_collapse")).toBe(true);
  });

  test("never modifies protected entities (numbers, emails)", () => {
    const tokens = tokenize("um we owe 5 dollars to bob@example.com");
    const mask = protectionMask(tokens);
    const { tokens: out } = cleanupGrammar(tokens, mask, {
      budget: budgetFor("assertive"),
      mode: "assertive",
    });
    const r = render(out);
    expect(r).toContain("5");
    expect(r).toContain("bob@example.com");
  });

  test("filler exception: user keeps 'um'", () => {
    const tokens = tokenize("um we should ship");
    const mask = protectionMask(tokens);
    const { tokens: out } = cleanupGrammar(tokens, mask, {
      budget: budgetFor("neutral"),
      mode: "neutral",
      fillerExceptions: new Set(["um"]),
    });
    expect(render(out).toLowerCase()).toContain("um");
  });
});
