import { describe, expect, it } from "vitest";
import { stripSoundTags } from "../flowValidation";

describe("stripSoundTags — wrapped tags", () => {
  it("removes a bracketed tag from a mixed utterance", () => {
    const r = stripSoundTags("yeah [cough] sure");
    expect(r.text).toBe("yeah sure");
    expect(r.tagsRemoved).toBe(1);
  });

  it("removes parenthesized and asterisked tags", () => {
    expect(stripSoundTags("hello *sigh* world").text).toBe("hello world");
    expect(stripSoundTags("well (laugh) okay").text).toBe("well okay");
  });

  it("handles tags with inner whitespace and trailing punctuation", () => {
    expect(stripSoundTags("yes [ Cough. ] please").text).toBe("yes please");
  });

  it("leaves non-sound-word bracketed content alone", () => {
    expect(stripSoundTags("hello [John] world").text).toBe("hello [John] world");
  });

  it("strips whisper keyboard-onomatopoeia (*Tonk*, *Thud*, *Clack*)", () => {
    // Regression: user reported *Tonk* leaking through during typing.
    expect(stripSoundTags("*Tonk*").text).toBe("");
    expect(stripSoundTags("hello *tonk* world").text).toBe("hello world");
    expect(stripSoundTags("*Thud* right there").text).toBe("right there");
    expect(stripSoundTags("great *Clack*").text).toBe("great");
  });

  it("strips whisper emotional/body sound tags (*crying*, *sob*)", () => {
    expect(stripSoundTags("*crying*").text).toBe("");
    expect(stripSoundTags("i mean *crying* it's fine").text).toBe("i mean it's fine");
    expect(stripSoundTags("*sobbing* really").text).toBe("really");
  });

  it("strips any single- or double-word asterisk-wrapped content", () => {
    // Whisper non-verbal descriptors we haven't enumerated — strip anyway.
    expect(stripSoundTags("*Zzzt* ok go").text).toBe("ok go");
    expect(stripSoundTags("go *keyboard tap* fine").text).toBe("go fine");
    expect(stripSoundTags("*Whirr*").text).toBe("");
  });

  it("preserves long asterisk-wrapped emphasis (>32 chars or >2 words)", () => {
    const input = "check *this is actually very important note*";
    expect(stripSoundTags(input).text).toBe(input);
  });

  it("leaves bracketed mentions and parenthesized asides alone", () => {
    expect(stripSoundTags("hey [John] look").text).toBe("hey [John] look");
    expect(stripSoundTags("go there (or maybe not)").text).toBe("go there (or maybe not)");
  });
});

describe("stripSoundTags — bare boundary tokens", () => {
  it("strips a bare leading tag followed by pause marker", () => {
    expect(stripSoundTags("cough. let's begin.").text).toBe("let's begin.");
  });

  it("strips a bare trailing tag preceded by pause marker", () => {
    expect(stripSoundTags("all done. cough").text).toBe("all done.");
  });

  it("preserves bare sound word inside a natural phrase", () => {
    const input = "the cough was bad";
    expect(stripSoundTags(input).text).toBe(input);
  });

  it("does not strip bare sound word at end without pause marker", () => {
    // "hello cough" — cough at end, no boundary, stays.
    expect(stripSoundTags("hello cough").text).toBe("hello cough");
  });

  it("rejection path: pure tag survives stripper, caller rejects via isSoundTagOnly", () => {
    // stripSoundTags will empty this out; caller's validator then hits
    // "sound_tag_only" because the original text was a tag.
    const r = stripSoundTags("[cough]");
    expect(r.text).toBe("");
    expect(r.tagsRemoved).toBe(1);
  });
});

describe("stripSoundTags — edge-noise secondary rule", () => {
  it("strips a short leading token in weak audio", () => {
    const r = stripSoundTags("uh. let's go.", {
      rmsDb: -50, // below FLOW_AUDIO_MIN_RMS_DB + 4 = -38
      silenceRatio: 0.9,
      speechRatio: 0.3,
    });
    expect(r.edgeNoiseRemoved).toContain("uh");
    expect(r.text).toBe("let's go.");
  });

  it("preserves a short leading token in clean audio", () => {
    const r = stripSoundTags("uh. let's go.", {
      rmsDb: -20,
      silenceRatio: 0.2,
      speechRatio: 0.8,
    });
    expect(r.edgeNoiseRemoved).toEqual([]);
    expect(r.text).toBe("uh. let's go.");
  });

  it("does not strip tokens inside the utterance body even in weak audio", () => {
    const r = stripSoundTags("hello uh world", {
      rmsDb: -50,
      silenceRatio: 0.9,
      speechRatio: 0.3,
    });
    expect(r.text).toBe("hello uh world");
  });
});
