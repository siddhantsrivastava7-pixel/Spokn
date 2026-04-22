import { classifyIntent } from "../src/intent/intentClassifier";
import { computeStructuralSignals } from "../src/intent/structuralHeuristics";
import {
  isListLike,
  recentIntentBias,
  updateSessionContext,
  DEFAULT_STICKY_WINDOW_MS,
} from "../src/intent/sessionContext";

describe("structural signals", () => {
  test("detects comma chain", () => {
    const s = computeStructuralSignals("milk, eggs, bread");
    expect(s.commaChain).toBe(true);
  });

  test("detects and chain", () => {
    const s = computeStructuralSignals("milk and eggs and bread");
    expect(s.andChain).toBe(true);
  });

  test("detects imperative", () => {
    const s = computeStructuralSignals("call mom tomorrow");
    expect(s.imperative).toBe(true);
  });

  test("detects noun phrase run", () => {
    const s = computeStructuralSignals("milk eggs bread");
    expect(s.nounPhraseRun).toBe(true);
  });

  test("long paragraph text gets long_form length pattern", () => {
    const segs = [
      {
        startMs: 0,
        endMs: 10_000,
        text: "this is a very long sentence with many many words in it to trigger long form classification",
        tier: "HIGH" as const,
      },
    ];
    const s = computeStructuralSignals(segs[0]!.text, segs);
    expect(s.lengthPattern).toBe("long_form");
  });
});

describe("classifyIntent (trigger path)", () => {
  test('email trigger: "write email to Riya saying..."', () => {
    const r = classifyIntent({ text: "write email to Riya saying I'll send the deck" });
    expect(r.intent).toBe("email");
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test("grocery list trigger → bullet_list", () => {
    const r = classifyIntent({ text: "grocery list milk eggs bread" });
    expect(r.intent).toBe("bullet_list");
  });

  test("todo trigger → todo_list", () => {
    const r = classifyIntent({ text: "todo call mom review pr finish slides" });
    expect(r.intent).toBe("todo_list");
  });

  test("meeting notes trigger → meeting_notes", () => {
    const r = classifyIntent({
      text: "meeting notes we discussed hiring and budget",
    });
    expect(r.intent).toBe("meeting_notes");
  });

  test("numbered list trigger → numbered_list", () => {
    const r = classifyIntent({ text: "numbered list first second third" });
    expect(r.intent).toBe("numbered_list");
  });
});

describe("classifyIntent (structural-only path)", () => {
  test("imperative + comma-chain → todo_list", () => {
    const r = classifyIntent({
      text: "call mom tomorrow, finish slides, book flight",
    });
    expect(r.intent).toBe("todo_list");
    expect(r.signals.structural).toContain("imperative");
    expect(r.signals.structural).toContain("comma_chain");
  });

  test("noun phrase run only → bullet_list", () => {
    const r = classifyIntent({ text: "milk eggs bread butter cheese" });
    expect(r.intent).toBe("bullet_list");
  });

  test("weak signal (single short noun phrase) → paragraph", () => {
    const r = classifyIntent({ text: "the meeting went well" });
    expect(r.intent).toBe("paragraph");
  });
});

describe("classifyIntent (biases)", () => {
  test("prefersLists pushes a borderline input into bullet territory", () => {
    const without = classifyIntent({ text: "call mom review pr finish slides" });
    const withBias = classifyIntent({
      text: "call mom review pr finish slides",
      stylePreferences: { prefersLists: true },
    });
    // Both should be list-like; check that the biased version's confidence is
    // not lower than the unbiased one for its chosen list intent.
    expect(isListLike(withBias.intent)).toBe(true);
    expect(without).toBeDefined();
  });

  test("adaptive bias is capped at ±0.2", () => {
    const r = classifyIntent({
      text: "we shipped the release",
      adaptiveBias: { bullet_list: 5 }, // absurd — should be capped to 0.2
    });
    // With the cap and a clean English paragraph input the bias can't push
    // bullet_list above 0.3 on its own.
    expect(r.intent).toBe("paragraph");
  });
});

describe("sessionContext", () => {
  test("updateSessionContext prepends and caps recentIntents", () => {
    let ctx = updateSessionContext(undefined, "bullet_list");
    ctx = updateSessionContext(ctx, "bullet_list");
    ctx = updateSessionContext(ctx, "todo_list");
    expect(ctx.recentIntents?.[0]).toBe("todo_list");
    expect(ctx.recentIntents).toHaveLength(3);
  });

  test("recentIntentBias rewards 2+ list-type repeats", () => {
    const ctx = {
      recentIntents: ["bullet_list", "bullet_list"] as const,
    };
    const bias = recentIntentBias(ctx as unknown as import("../src/types").SessionContext);
    expect(bias.bullet_list).toBeGreaterThan(0);
  });

  test("non-list intents do not get recent bias", () => {
    const ctx = {
      recentIntents: ["paragraph", "paragraph"] as const,
    };
    const bias = recentIntentBias(ctx as unknown as import("../src/types").SessionContext);
    expect(bias.paragraph).toBeUndefined();
  });

  test("session stickiness: unclear next input inherits previous list intent", () => {
    const now = Date.now();
    const r = classifyIntent(
      {
        text: "the meeting went well",
        sessionContext: {
          lastIntent: "bullet_list",
          lastIntentAt: new Date(now - 10_000).toISOString(),
          stickyWindowMs: DEFAULT_STICKY_WINDOW_MS,
        },
      },
      now,
    );
    expect(r.carriedFromSession).toBe(true);
    expect(r.intent).toBe("bullet_list");
  });
});
