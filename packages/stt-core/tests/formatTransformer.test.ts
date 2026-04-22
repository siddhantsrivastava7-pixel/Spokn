import { transformToFormat } from "../src/intent/formatTransformer";
import type { IntentDetection } from "../src/types";

function intent(
  type: IntentDetection["intent"],
  confidence: number,
  structural: string[] = [],
): IntentDetection {
  return {
    intent: type,
    confidence,
    signals: { triggers: [], structural },
  };
}

describe("transformToFormat (full mode)", () => {
  test("bullet_list with • symbol", () => {
    const r = transformToFormat({
      text: "grocery list milk eggs bread",
      intent: intent("bullet_list", 0.9, ["noun_phrase_run"]),
      depth: "full",
    });
    expect(r.output).toBe("• Milk\n• Eggs\n• Bread");
    expect(r.scaffolding.length).toBeGreaterThan(0);
    expect(r.scaffolding.every((s) => s.kind === "scaffolding")).toBe(true);
  });

  test("todo_list with - [ ] checkboxes", () => {
    const r = transformToFormat({
      text: "call mom, finish slides, book flight",
      intent: intent("todo_list", 0.9, ["comma_chain"]),
      depth: "full",
    });
    expect(r.output.split("\n")).toEqual([
      "- [ ] Call mom",
      "- [ ] Finish slides",
      "- [ ] Book flight",
    ]);
  });

  test("numbered_list", () => {
    const r = transformToFormat({
      text: "numbered list first second third",
      intent: intent("numbered_list", 0.9, ["noun_phrase_run"]),
      depth: "full",
    });
    expect(r.output).toBe("1. First\n2. Second\n3. Third");
  });

  test("email template filled", () => {
    const r = transformToFormat({
      text: "write email to Riya saying I'll send the deck",
      intent: intent("email", 0.9),
      depth: "full",
    });
    expect(r.output).toContain("Subject: Update");
    expect(r.output).toContain("Hi Riya,");
    expect(r.output).toContain("I'll send the deck.");
    expect(r.output).toContain("Best,");
    expect(r.output).toContain("[User]");
  });

  test("meeting_notes: header + • bullets", () => {
    const r = transformToFormat({
      text: "meeting notes we discussed hiring. we reviewed budget.",
      intent: intent("meeting_notes", 0.9),
      depth: "full",
    });
    expect(r.output.startsWith("Meeting Notes")).toBe(true);
    expect(r.output).toContain("•");
  });

  test("paragraph passes through unchanged", () => {
    const r = transformToFormat({
      text: "We shipped the release today.",
      intent: intent("paragraph", 0.9),
      depth: "full",
    });
    expect(r.output).toBe("We shipped the release today.");
    expect(r.scaffolding).toHaveLength(0);
  });
});

describe("transformToFormat (light mode — ambiguous signal)", () => {
  test("partial list signal: paragraph with line breaks, no bullets", () => {
    const r = transformToFormat({
      text: "milk. eggs. bread.",
      intent: intent("bullet_list", 0.45), // light-mode band
      depth: "full",
    });
    expect(r.output).not.toContain("•");
    expect(r.output.split("\n").length).toBeGreaterThan(1);
    expect(r.scaffolding).toHaveLength(0);
  });

  test("partial todo signal: no checkboxes", () => {
    const r = transformToFormat({
      text: "call mom. finish slides. book flight.",
      intent: intent("todo_list", 0.45),
      depth: "full",
    });
    expect(r.output).not.toContain("[ ]");
  });

  test("confidence < 0.3 returns identity", () => {
    const r = transformToFormat({
      text: "some text",
      intent: intent("bullet_list", 0.1),
      depth: "full",
    });
    expect(r.output).toBe("some text");
  });
});

describe("transformToFormat (depth=light forces light mode)", () => {
  test("strong bullet intent in light depth stays paragraphic", () => {
    const r = transformToFormat({
      text: "grocery list milk eggs bread",
      intent: intent("bullet_list", 0.9, ["noun_phrase_run"]),
      depth: "light",
    });
    expect(r.output).not.toContain("•");
  });
});
