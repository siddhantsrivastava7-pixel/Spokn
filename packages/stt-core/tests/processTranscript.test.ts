import { processTranscript } from "../src/postprocessing/processTranscript";
import type { ScoredSegment } from "../src/types";

function seg(
  text: string,
  tier: ScoredSegment["tier"] = "HIGH",
  reprocessed = false,
): ScoredSegment {
  const s: ScoredSegment = {
    startMs: 0,
    endMs: 1000,
    text,
    tier,
  };
  if (reprocessed) s.reprocessed = true;
  return s;
}

describe("processTranscript — strict no-hallucination invariant", () => {
  test("correctedText never introduces new words", () => {
    const input = "um we should uh ship the release tomorrow";
    const r = processTranscript({ text: input, segments: [seg(input)] });
    const rawWords = new Set(input.toLowerCase().split(/\s+/));
    for (const word of r.correctedText.toLowerCase().split(/\s+/).filter(Boolean)) {
      const pure = word.replace(/[^a-z']/g, "");
      if (!pure) continue;
      expect(rawWords.has(pure)).toBe(true);
    }
  });

  test("tone preservation: 'i think we should ship' keeps 'I think'", () => {
    const input = "i think we should ship friday";
    const r = processTranscript({ text: input, segments: [seg(input)] });
    expect(r.correctedText.toLowerCase()).toContain("i think");
    expect(r.correctedText.toLowerCase()).toContain("we should ship");
  });

  test("correction kinds never include subject or connector", () => {
    const input = "um we should ship the release";
    const r = processTranscript({ text: input, segments: [seg(input)] });
    const kinds = new Set(r.corrections.map((c) => c.kind));
    expect(kinds.has("subject" as never)).toBe(false);
    expect(kinds.has("connector" as never)).toBe(false);
  });
});

describe("processTranscript — short-input guard", () => {
  test("< 5 words skips formatting", () => {
    const r = processTranscript({ text: "hello world", segments: [seg("hello world")] });
    expect(r.detectedIntent.intent).toBe("paragraph");
    expect(r.detectedIntent.confidence).toBe(0);
    expect(r.formattedOutput).toBe("Hello world.");
    expect(r.transformationLevel).toBe("low");
  });
});

describe("processTranscript — segment-based aggregate mode", () => {
  test("LOW segment forces strict mode → filler not removed", () => {
    const input = "um we should ship the release tomorrow";
    const r = processTranscript({
      text: input,
      segments: [seg(input, "LOW")],
    });
    expect(r.correctedText.toLowerCase()).toContain("um");
  });

  test("LOW-but-reprocessed segment gets neutral mode → filler removed", () => {
    const input = "um we should ship the release tomorrow";
    const r = processTranscript({
      text: input,
      segments: [seg(input, "LOW", true)],
    });
    expect(r.correctedText.toLowerCase()).not.toContain(" um ");
  });
});

describe("processTranscript — full pipeline goldens", () => {
  test("grocery list → • bullets", () => {
    const input = "grocery list milk eggs bread";
    const r = processTranscript({ text: input, segments: [seg(input)] });
    expect(r.detectedIntent.intent).toBe("bullet_list");
    expect(r.formattedOutput).toBe("• Milk\n• Eggs\n• Bread");
  });

  test("imperative + comma chain → todo list", () => {
    const input = "call mom tomorrow, finish slides, book flight";
    const r = processTranscript({ text: input, segments: [seg(input)] });
    expect(r.detectedIntent.intent).toBe("todo_list");
    expect(r.formattedOutput).toContain("- [ ]");
  });

  test("email trigger → template", () => {
    const input = "write email to Riya saying I'll send the deck";
    const r = processTranscript({ text: input, segments: [seg(input)] });
    expect(r.formattedOutput).toContain("Subject: Update");
    expect(r.formattedOutput).toContain("Hi Riya,");
    expect(r.transformationLevel).toBe("high");
  });

  test("Hinglish auto: 'yaar me office jaa raha hu' preserved with casing fix", () => {
    const input = "yaar me office jaa raha hu";
    const r = processTranscript({
      text: input,
      segments: [seg(input)],
      language: "hinglish",
    });
    expect(r.hinglishApplied).toBe(true);
    expect(r.correctedText.toLowerCase()).toContain("mein");
    expect(r.correctedText).toMatch(/^Yaar/);
  });

  test("entity protection: numbers and emails preserved", () => {
    const input = "um please send 5 to bob@example.com today";
    const r = processTranscript({ text: input, segments: [seg(input)] });
    expect(r.correctedText).toContain("5");
    expect(r.correctedText).toContain("bob@example.com");
  });

  test("depth: light suppresses full-mode templates", () => {
    const input = "write email to Riya saying hello";
    const r = processTranscript({
      text: input,
      segments: [seg(input)],
      depth: "light",
    });
    expect(r.formattedOutput).not.toContain("Subject:");
  });

  test("formal tone expands contractions", () => {
    const input = "I'm going to ship we're ready tomorrow";
    const r = processTranscript({
      text: input,
      segments: [seg(input)],
      stylePreferences: { tone: "formal" },
    });
    expect(r.correctedText).toContain("I am");
    expect(r.correctedText).toContain("we are");
    expect(r.correctedText).not.toMatch(/we're|I'm/i);
  });

  test("casual/neutral tone keeps contractions", () => {
    const input = "we're going to ship the release";
    const r = processTranscript({
      text: input,
      segments: [seg(input)],
      stylePreferences: { tone: "casual" },
    });
    expect(r.correctedText.toLowerCase()).toContain("we're");
  });

  test("adaptive rules: user-exempted filler preserved", () => {
    const input = "um we should ship the release tomorrow";
    const r = processTranscript({
      text: input,
      segments: [seg(input)],
      adaptiveRules: { fillerExceptions: ["um"] },
    });
    expect(r.correctedText.toLowerCase()).toContain("um");
  });
});

describe("processTranscript — transformation level", () => {
  test("plain English paragraph → low", () => {
    const input = "We shipped the release today.";
    const r = processTranscript({ text: input, segments: [seg(input)] });
    expect(r.transformationLevel).toBe("low");
  });

  test("bullet output → medium (structural change)", () => {
    const input = "grocery list milk eggs bread";
    const r = processTranscript({ text: input, segments: [seg(input)] });
    expect(r.transformationLevel).toBe("medium");
  });

  test("email template → high", () => {
    const input = "write email to Priya saying hello";
    const r = processTranscript({ text: input, segments: [seg(input)] });
    expect(r.transformationLevel).toBe("high");
  });
});
