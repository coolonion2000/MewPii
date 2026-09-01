/** Promise latch for commands submitted before a conversation is ready. @author coolonion */
interface ReadinessWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class ReadinessWaiters {
  private readonly waiters = new Set<ReadinessWaiter>();

  wait(timeoutMs = 60_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter: ReadinessWaiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("session initialization timed out"));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  resolveAll(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.waiters.clear();
  }

  rejectAll(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}
