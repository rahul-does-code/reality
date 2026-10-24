// Snapshot-based undo stack. Index 0 is always the untouched frozen frame.
// Each edit pushes the *resulting* frame, so undo = pop and redraw the previous one.

export class FrameHistory {
  private stack: ImageData[] = [];

  reset(base: ImageData) {
    this.stack = [base];
  }

  push(frame: ImageData) {
    this.stack.push(frame);
  }

  get current(): ImageData | null {
    return this.stack[this.stack.length - 1] ?? null;
  }

  get original(): ImageData | null {
    return this.stack[0] ?? null;
  }

  get canUndo(): boolean {
    return this.stack.length > 1;
  }

  get depth(): number {
    return Math.max(0, this.stack.length - 1);
  }

  undo(): ImageData | null {
    if (this.stack.length > 1) this.stack.pop();
    return this.current;
  }

  clear() {
    this.stack = [];
  }
}
