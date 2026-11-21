import { scheduler } from "node:timers/promises";

/** Finish when the observed value is truthy; the monotonic deadline only bounds a failed test. */
export async function pollFor<T>(read: () => T | Promise<T>, label: string, timeout = 5000): Promise<NonNullable<T>> {
  const end = performance.now() + timeout;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (performance.now() >= end) throw new Error(`Timed out waiting for ${label}`);
    await scheduler.wait(10);
  }
}
