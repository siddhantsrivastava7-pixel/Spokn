import { LatencyBudget } from "../src/pipeline/latencyBudget";

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("LatencyBudget", () => {
  test("elapsed is non-negative from construction", async () => {
    const budget = new LatencyBudget(1000);
    await sleep(20);
    expect(budget.elapsed()).toBeGreaterThanOrEqual(15);
  });

  test("remaining never goes below zero", async () => {
    const budget = new LatencyBudget(10);
    await sleep(30);
    expect(budget.remaining()).toBe(0);
  });

  test("shouldSkip returns true when remaining is less than stage cost", async () => {
    const budget = new LatencyBudget(50);
    await sleep(60);
    expect(budget.shouldSkip(20)).toBe(true);
  });

  test("shouldSkip returns false when budget is ample", () => {
    const budget = new LatencyBudget(10_000);
    expect(budget.shouldSkip(100)).toBe(false);
  });

  test("recordDowngrade accumulates reasons in order", () => {
    const budget = new LatencyBudget(1000);
    budget.recordDowngrade("a");
    budget.recordDowngrade("b");
    expect(budget.downgrades).toEqual(["a", "b"]);
  });

  test("breakdown reports per-mark durations", async () => {
    const budget = new LatencyBudget(1000);
    await sleep(20);
    budget.mark("stage1");
    await sleep(20);
    budget.mark("stage2");
    const breakdown = budget.breakdown();
    expect(Object.keys(breakdown)).toEqual(["stage1", "stage2"]);
    expect(breakdown.stage1).toBeGreaterThanOrEqual(10);
    expect(breakdown.stage2).toBeGreaterThanOrEqual(10);
  });
});
