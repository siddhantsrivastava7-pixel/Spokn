import { describe, expect, it } from "vitest";
import {
  diffTokens,
  normalizeFingerprint,
} from "../flowExternalEditCapture";

describe("normalizeFingerprint", () => {
  it("lowercases process, trims and collapses whitespace in title", () => {
    const fp = normalizeFingerprint("Slack.exe", "  Design   Review  ");
    expect(fp).toBe("slack.exe\x1fDesign Review");
  });

  it("strips a leading unread counter", () => {
    const fp = normalizeFingerprint("Slack.exe", "(3) #design-review");
    expect(fp).toBe("slack.exe\x1f#design-review");
  });

  it("strips a trailing unsaved marker", () => {
    const fp = normalizeFingerprint("Code.exe", "main.ts *");
    expect(fp).toBe("code.exe\x1fmain.ts");
  });

  it("strips only known cosmetic browser suffixes", () => {
    expect(normalizeFingerprint("chrome.exe", "ChatGPT - Google Chrome")).toBe(
      "chrome.exe\x1fChatGPT",
    );
  });

  it("does NOT strip arbitrary dash suffixes", () => {
    // VS Code title: "file.ts - project - Visual Studio Code" must stay
    // disambiguated from "other.ts - project - Visual Studio Code".
    const a = normalizeFingerprint("Code.exe", "main.ts - project - VS Code");
    const b = normalizeFingerprint("Code.exe", "other.ts - project - VS Code");
    expect(a).not.toBe(b);
  });

  it("produces stable fingerprint across title churn (unread + suffix)", () => {
    const a = normalizeFingerprint("chrome.exe", "(2) Claude - Google Chrome");
    const b = normalizeFingerprint("chrome.exe", "Claude - Google Chrome");
    expect(a).toBe(b);
  });
});

describe("diffTokens", () => {
  it("detects zero changes for identical text", () => {
    const r = diffTokens("hello world", "hello world");
    expect(r.changes).toEqual([]);
    expect(r.jaccard).toBe(1);
  });

  it("captures a single-word substitution", () => {
    const r = diffTokens("Whisper is good", "Wispr is good");
    expect(r.changes).toEqual([{ from: "Whisper", to: "Wispr" }]);
  });

  it("captures an insertion", () => {
    const r = diffTokens("hello world", "hello there world");
    expect(r.changes.length).toBeGreaterThan(0);
    expect(r.changes[0]).toEqual({ from: "", to: "there" });
  });

  it("captures a deletion", () => {
    const r = diffTokens("hello there world", "hello world");
    expect(r.changes[0]).toEqual({ from: "there", to: "" });
  });

  it("jaccard below 0.5 for mostly-disjoint texts", () => {
    const r = diffTokens("hello there friend", "goodbye stranger quickly");
    expect(r.jaccard).toBeLessThan(0.5);
  });
});
