import {
  correctHinglish,
  looksHinglish,
} from "../src/postprocessing/hinglishCorrector";
import {
  protectionMask,
  tokenize,
} from "../src/postprocessing/entityProtection";
import { budgetFor } from "../src/postprocessing/correctionMode";

function render(tokens: ReturnType<typeof tokenize>): string {
  return tokens.map((t) => t.text).join("");
}

describe("looksHinglish", () => {
  test("detects Hinglish context with ≥2 markers", () => {
    expect(looksHinglish("yaar office jaa raha hu")).toBe(true);
  });
  test("returns false for pure English", () => {
    expect(looksHinglish("we should ship the release")).toBe(false);
  });
  test("returns false with only 1 marker", () => {
    expect(looksHinglish("the project is going well")).toBe(false);
  });
});

describe("correctHinglish", () => {
  const neutralBudget = budgetFor("neutral");

  test("canonical casing from dictionary", () => {
    const text = "met priya at zomato";
    const tokens = tokenize(text);
    const mask = protectionMask(tokens);
    const { tokens: out, corrections } = correctHinglish(tokens, mask, {
      budget: neutralBudget,
      mode: "neutral",
    });
    const rendered = render(out);
    expect(rendered).toContain("Priya");
    expect(rendered).toContain("Zomato");
    expect(corrections.map((c) => c.kind)).toEqual(["hinglish", "hinglish"]);
  });

  test('"me" → "mein" fires only in Hinglish context', () => {
    const hinglishTokens = tokenize("yaar me office jaa raha hu");
    const hinglishMask = protectionMask(hinglishTokens);
    const resHinglish = correctHinglish(hinglishTokens, hinglishMask, {
      budget: neutralBudget,
      mode: "neutral",
    });
    expect(render(resHinglish.tokens)).toContain("mein");

    const englishTokens = tokenize("please email me tomorrow");
    const englishMask = protectionMask(englishTokens);
    const resEnglish = correctHinglish(englishTokens, englishMask, {
      budget: neutralBudget,
      mode: "neutral",
    });
    expect(render(resEnglish.tokens)).toBe("please email me tomorrow");
  });

  test("does NOT translate Hinglish to English", () => {
    const text = "yaar aaj office jaa raha hu";
    const tokens = tokenize(text);
    const mask = protectionMask(tokens);
    const res = correctHinglish(tokens, mask, {
      budget: neutralBudget,
      mode: "neutral",
    });
    const rendered = render(res.tokens);
    // Hinglish tokens preserved verbatim.
    expect(rendered).toContain("yaar");
    expect(rendered).toContain("jaa raha hu");
  });

  test("respects protection mask (proper nouns unchanged)", () => {
    const text = "i met Riya at the office";
    const tokens = tokenize(text);
    const mask = protectionMask(tokens);
    const res = correctHinglish(tokens, mask, {
      budget: neutralBudget,
      mode: "neutral",
    });
    // Riya was already capitalized and mid-sentence → protected. No change.
    expect(render(res.tokens)).toContain("Riya");
    expect(
      res.corrections.find((c) => c.from.toLowerCase() === "riya"),
    ).toBeUndefined();
  });

  test("bigram rewrite: 'react js' → 'React.js'", () => {
    const text = "learning react js";
    const tokens = tokenize(text);
    const mask = protectionMask(tokens);
    const res = correctHinglish(tokens, mask, {
      budget: neutralBudget,
      mode: "neutral",
    });
    expect(render(res.tokens)).toContain("React.js");
  });

  test("adaptive overrides win over defaults", () => {
    const text = "hi siddharth";
    const tokens = tokenize(text);
    const mask = protectionMask(tokens);
    const res = correctHinglish(tokens, mask, {
      budget: neutralBudget,
      mode: "neutral",
      overrides: { siddharth: "Sid" },
    });
    expect(render(res.tokens)).toContain("Sid");
  });
});
