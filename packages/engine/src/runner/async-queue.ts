/** Minimal pushable async iterable: producers `push`, one consumer iterates, `end` closes. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: ((r: IteratorResult<T>) => void) | null = null;
  private ended = false;

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    if (this.ended) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  end(): void {
    this.ended = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}
