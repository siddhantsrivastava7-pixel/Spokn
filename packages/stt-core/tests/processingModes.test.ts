import {
  PROCESSING_MODES,
  presetFor,
} from "../src/pipeline/processingModes";

describe("processingModes", () => {
  test("instant: no preprocessing, no reprocess, light depth, tight budget", () => {
    expect(PROCESSING_MODES.instant).toEqual({
      preprocessing: "never",
      selectiveReprocess: false,
      postProcessingDepth: "light",
      latencyBudgetMs: 600,
    });
  });

  test("balanced: adaptive, reprocess enabled, full depth, 1.2s budget", () => {
    expect(PROCESSING_MODES.balanced).toEqual({
      preprocessing: "adaptive",
      selectiveReprocess: true,
      postProcessingDepth: "full",
      latencyBudgetMs: 1200,
    });
  });

  test("accuracy: always preprocess, reprocess, full depth, wide budget", () => {
    expect(PROCESSING_MODES.accuracy).toEqual({
      preprocessing: "always",
      selectiveReprocess: true,
      postProcessingDepth: "full",
      latencyBudgetMs: 4000,
    });
  });

  test("presetFor defaults to balanced on undefined", () => {
    expect(presetFor(undefined)).toBe(PROCESSING_MODES.balanced);
  });

  test("presetFor returns the exact preset for each mode", () => {
    expect(presetFor("instant")).toBe(PROCESSING_MODES.instant);
    expect(presetFor("accuracy")).toBe(PROCESSING_MODES.accuracy);
  });
});
