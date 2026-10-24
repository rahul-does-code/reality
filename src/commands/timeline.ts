// Per-command latency marks, printed as one console line:
//   [timing] "remove that": speech end → transcript +180ms → command parsed +1240ms → ... (total 10.9s)

export class Timeline {
  private marks: [string, number][] = [];

  constructor(private label: string, first?: string) {
    if (first) this.mark(first);
  }

  mark(name: string): void {
    this.marks.push([name, performance.now()]);
  }

  setLabel(label: string): void {
    this.label = label;
  }

  print(): void {
    if (this.marks.length < 2) return;
    const [[firstName, t0]] = this.marks;
    const steps = this.marks.slice(1).map(([name, t], i) => `${name} +${Math.round(t - this.marks[i][1])}ms`);
    const total = ((this.marks[this.marks.length - 1][1] - t0) / 1000).toFixed(2);
    console.log(`[timing] ${this.label}: ${firstName} → ${steps.join(" → ")} (total ${total}s)`);
  }
}
