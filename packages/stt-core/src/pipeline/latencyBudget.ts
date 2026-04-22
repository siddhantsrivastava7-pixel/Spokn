/**
 * Tracks elapsed wall-clock time across pipeline stages and decides when
 * optional stages should be skipped to stay under budget.
 *
 * Cheap by design: no timers, no async work — it just reads Date.now().
 */
export class LatencyBudget {
  private readonly startedAt: number;
  private readonly marks: Array<{ label: string; at: number }> = [];
  readonly downgrades: string[] = [];

  constructor(private readonly budgetMs: number) {
    this.startedAt = Date.now();
  }

  mark(label: string): void {
    this.marks.push({ label, at: Date.now() });
  }

  elapsed(): number {
    return Date.now() - this.startedAt;
  }

  remaining(): number {
    return Math.max(0, this.budgetMs - this.elapsed());
  }

  /**
   * True if running a stage that costs roughly `stageCostMs` would exceed
   * the budget. Callers record a `downgrades[]` reason when they honor this.
   */
  shouldSkip(stageCostMs: number): boolean {
    return this.remaining() < stageCostMs;
  }

  recordDowngrade(reason: string): void {
    this.downgrades.push(reason);
  }

  /**
   * Per-stage durations: difference between consecutive marks. The first
   * mark is measured from budget construction. Missing/misordered marks
   * just yield zeros — this is telemetry, not a correctness boundary.
   */
  breakdown(): Record<string, number> {
    const out: Record<string, number> = {};
    let prev = this.startedAt;
    for (const m of this.marks) {
      out[m.label] = Math.max(0, m.at - prev);
      prev = m.at;
    }
    return out;
  }
}
