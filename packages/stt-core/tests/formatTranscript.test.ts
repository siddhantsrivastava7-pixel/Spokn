import { formatByIntent } from "../src/postprocessing/formatTranscript";
import type { TranscriptSegment } from "../src/types";

const mkSeg = (text: string, startMs: number, endMs: number): TranscriptSegment => ({
  text,
  startMs,
  endMs,
});

describe("formatByIntent", () => {
  describe("LIST", () => {
    test("one segment → one bullet", () => {
      const segs = [
        mkSeg("eggs", 0, 500),
        mkSeg("milk", 900, 1300),
        mkSeg("bread", 1700, 2100),
      ];
      const out = formatByIntent("LIST", segs, "eggs milk bread");
      expect(out).toBe("- Eggs\n- Milk\n- Bread");
    });

    test("capitalizes each bullet; strips stray leading bullets", () => {
      const segs = [mkSeg("* apples", 0, 500), mkSeg("bananas", 900, 1300)];
      expect(formatByIntent("LIST", segs, "* apples bananas")).toBe(
        "- Apples\n- Bananas",
      );
    });

    test("falls back to splitting fullText when segments is empty", () => {
      const out = formatByIntent("LIST", [], "eggs. milk. bread.");
      expect(out).toBe("- Eggs\n- Milk\n- Bread");
    });
  });

  describe("COMMAND", () => {
    test("single clean line, fillers removed, terminal punctuation stripped", () => {
      const out = formatByIntent(
        "COMMAND",
        [],
        "um send an email to alex uh right now.",
      );
      expect(out).toBe("Send an email to alex right now");
    });
  });

  describe("PARAGRAPH", () => {
    test("merges text, capitalizes sentence starts, adds terminal period", () => {
      const out = formatByIntent(
        "PARAGRAPH",
        [],
        "the roadmap is ready. we ship next week",
      );
      expect(out).toBe("The roadmap is ready. We ship next week.");
    });

    test("preserves existing terminal punctuation", () => {
      expect(formatByIntent("PARAGRAPH", [], "done!")).toBe("Done!");
    });
  });

  describe("NOTE", () => {
    test("minimal cleaning only", () => {
      expect(formatByIntent("NOTE", [], "  hello   world  ")).toBe("hello world");
    });
  });

  describe("PARAGRAPH pause-aware punctuation", () => {
    test("long gap between segments → period + capitalized next sentence", () => {
      const segs = [
        mkSeg("the plan is ready", 0, 1500),
        mkSeg("we ship next week", 2500, 4000), // 1000ms gap → period
      ];
      const out = formatByIntent("PARAGRAPH", segs, "ignored");
      expect(out).toBe("The plan is ready. We ship next week.");
    });

    test("medium gap between segments → comma, continue same sentence", () => {
      const segs = [
        mkSeg("first draft is up", 0, 1500),
        mkSeg("please review it", 2000, 3500), // 500ms gap → comma
      ];
      const out = formatByIntent("PARAGRAPH", segs, "ignored");
      expect(out).toBe("First draft is up, please review it.");
    });

    test("preserves acronyms through paragraph capitalization", () => {
      const segs = [
        mkSeg("the CEO approved it", 0, 1500),
        mkSeg("API ships today", 2500, 4000),
      ];
      const out = formatByIntent("PARAGRAPH", segs, "ignored");
      expect(out).toContain("CEO");
      expect(out).toContain("API");
    });

    test("tight gaps merge as a single sentence", () => {
      const segs = [
        mkSeg("we are running", 0, 1000),
        mkSeg("ten minutes late", 1100, 2000), // 100ms gap → no punctuation
      ];
      const out = formatByIntent("PARAGRAPH", segs, "ignored");
      expect(out).toBe("We are running ten minutes late.");
    });
  });

  describe("LIST + COMMAND hybrid", () => {
    test("splits, inherits the leading verb, bullets", () => {
      const out = formatByIntent(
        { primary: "LIST", secondary: "COMMAND" },
        [],
        "buy milk, eggs and call mom",
      );
      expect(out).toBe("- Buy milk\n- Buy eggs\n- Call mom");
    });

    test("does not duplicate a verb that each bullet already has", () => {
      const out = formatByIntent(
        { primary: "LIST", secondary: "COMMAND" },
        [],
        "send the report, email the team and call the client",
      );
      // Each bullet already starts with its own verb — no inheritance needed.
      expect(out.split("\n")).toEqual([
        "- Send the report",
        "- Email the team",
        "- Call the client",
      ]);
    });
  });

  describe("confidence-aware PARAGRAPH formatting", () => {
    test("downgrades a period to a comma when adjacent segment is LOW", () => {
      const segs = [
        {
          text: "the plan is ready",
          startMs: 0,
          endMs: 1500,
          tier: "HIGH" as const,
        },
        {
          text: "we ship next week",
          startMs: 2500, // 1000ms gap → would normally be a period
          endMs: 4000,
          tier: "LOW" as const,
          confidenceLevel: "LOW" as const,
        },
      ];
      const out = formatByIntent("PARAGRAPH", segs, "ignored");
      expect(out).toContain(", we ship");
      expect(out).not.toContain(". We ship");
    });

    test("HIGH-confidence neighbors still get a period on a long gap", () => {
      const segs = [
        {
          text: "the plan is ready",
          startMs: 0,
          endMs: 1500,
          tier: "HIGH" as const,
          confidenceLevel: "HIGH" as const,
        },
        {
          text: "we ship next week",
          startMs: 2500,
          endMs: 4000,
          tier: "HIGH" as const,
          confidenceLevel: "HIGH" as const,
        },
      ];
      const out = formatByIntent("PARAGRAPH", segs, "ignored");
      expect(out).toBe("The plan is ready. We ship next week.");
    });
  });

  describe("back-compat signature", () => {
    test("string intent still works (FormatIntent branch)", () => {
      expect(formatByIntent("NOTE", [], "  hello  world  ")).toBe("hello world");
    });

    test("IntentResult without secondary behaves like its primary", () => {
      const a = formatByIntent("NOTE", [], "hello world");
      const b = formatByIntent({ primary: "NOTE" }, [], "hello world");
      expect(a).toBe(b);
    });
  });

  describe("idempotence", () => {
    test("LIST: formatByIntent twice yields same result the second time", () => {
      const segs = [mkSeg("eggs", 0, 500), mkSeg("milk", 900, 1300)];
      const first = formatByIntent("LIST", segs, "eggs milk");
      const second = formatByIntent("LIST", [], first);
      expect(second).toBe(first);
    });

    test("PARAGRAPH: idempotent", () => {
      const first = formatByIntent("PARAGRAPH", [], "the plan is set");
      const second = formatByIntent("PARAGRAPH", [], first);
      expect(second).toBe(first);
    });

    test("COMMAND: idempotent on already-clean input", () => {
      const first = formatByIntent("COMMAND", [], "Send the report");
      const second = formatByIntent("COMMAND", [], first);
      expect(second).toBe(first);
    });
  });
});
