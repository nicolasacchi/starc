/**
 * Reconnection is where a client that was "fine" turns into a client that is
 * stuck. These tests drive the backoff with an injected timer and an injected
 * jitter source, so the whole policy — growth, cap, budget, resync hook — is
 * exercised without a single real second of waiting.
 */
import { describe, expect, it, vi } from "vitest";
import {
  RECONNECT_BASE_MS,
  RECONNECT_CAP_MS,
  RECONNECT_MAX_ATTEMPTS,
  ReconnectController,
} from "./reconnect";
import type { TimerApi, TimerHandle } from "./reconnect";

/**
 * Yields a macrotask so the controller's async attempt chain drains. Zero
 * duration: it waits on a scheduling boundary, never on elapsed time.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A promise the test opens by hand, standing in for a reconnect attempt that
 * is still in flight. `Promise.withResolvers` is the natural spelling, but the
 * project's `lib` predates es2024, so the executor form is the one that
 * typechecks here.
 */
function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

class FakeTimer implements TimerApi {
  readonly delays: number[] = [];
  private readonly pending = new Map<TimerHandle, () => void>();
  private next = 1;

  set = (handler: () => void, delayMs: number): TimerHandle => {
    this.delays.push(delayMs);
    const handle = this.next++;
    this.pending.set(handle, handler);
    return handle;
  };

  clear = (handle: TimerHandle): void => {
    this.pending.delete(handle);
  };

  get scheduled(): number {
    return this.pending.size;
  }

  /** Fires the oldest scheduled callback and lets its promise settle. */
  async fire(): Promise<void> {
    const entry = this.pending.entries().next();
    if (entry.done) throw new Error("no timer is scheduled");
    this.pending.delete(entry.value[0]);
    entry.value[1]();
    await flush();
  }
}

describe("ReconnectController backoff", () => {
  it("grows exponentially from the base delay and stops at the cap", () => {
    const controller = new ReconnectController(async () => undefined, { random: () => 1 });

    expect(controller.backoffMs(1)).toBe(RECONNECT_BASE_MS);
    expect(controller.backoffMs(2)).toBe(RECONNECT_BASE_MS * 2);
    expect(controller.backoffMs(3)).toBe(RECONNECT_BASE_MS * 4);
    // Uncapped growth is a client that gives up on a server that is coming back.
    expect(controller.backoffMs(20)).toBe(RECONNECT_CAP_MS);
    expect(controller.backoffMs(100)).toBe(RECONNECT_CAP_MS);
  });

  it("applies full jitter, so the wait stays under the window it came from", () => {
    const worst = new ReconnectController(async () => undefined, { random: () => 0.999 });
    expect(worst.jitteredBackoffMs(5)).toBeLessThan(worst.backoffMs(5));

    const floored = new ReconnectController(async () => undefined, { random: () => 0 });
    // Zero jitter would replay the same collision on every client at once.
    expect(floored.jitteredBackoffMs(1)).toBe(0);
  });

  it("scatters the delay across the whole window rather than clustering", () => {
    const delays: number[] = [];
    const controller = new ReconnectController(async () => undefined, {
      random: () => delays.length / 10,
    });
    for (let i = 0; i < 10; i++) delays.push(controller.jitteredBackoffMs(1));
    expect(new Set(delays).size).toBe(10);
    expect(Math.max(...delays)).toBeLessThan(RECONNECT_BASE_MS);
  });

  it("honours an injected schedule instead of the defaults", () => {
    const controller = new ReconnectController(async () => undefined, {
      baseMs: 40,
      factor: 3,
      capMs: 500,
      random: () => 1,
    });
    expect(controller.backoffMs(1)).toBe(40);
    expect(controller.backoffMs(2)).toBe(120);
    expect(controller.backoffMs(3)).toBe(360);
    expect(controller.backoffMs(4)).toBe(500);
  });
});

describe("ReconnectController loop", () => {
  it("retries on a timer and reports each attempt with its delay", async () => {
    const timer = new FakeTimer();
    const attempts: number[] = [];
    const attempt = vi.fn(async () => {
      throw new Error("still down");
    });
    const controller = new ReconnectController(attempt, {
      timer,
      random: () => 1,
      onAttempt: (n) => attempts.push(n),
    });

    controller.notifyLoss();
    expect(controller.active).toBe(true);
    await timer.fire();
    await timer.fire();

    // The third attempt is already queued behind its own backoff.
    expect(attempts).toEqual([1, 2, 3]);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(timer.delays).toEqual([RECONNECT_BASE_MS, RECONNECT_BASE_MS * 2, RECONNECT_BASE_MS * 4]);
  });

  it("gives up after the attempt budget and stops trying", async () => {
    const timer = new FakeTimer();
    const giveUp = vi.fn();
    const attempt = vi.fn(async () => {
      throw new Error("server is gone");
    });
    const controller = new ReconnectController(attempt, { timer, maxAttempts: 3, onGiveUp: giveUp });

    controller.notifyLoss();
    for (let i = 0; i < 3; i++) await timer.fire();

    // Blowing past the budget is a client that reconnects all night.
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(giveUp).toHaveBeenCalledWith(3);
    expect(controller.active).toBe(false);
    expect(timer.scheduled).toBe(0);
  });

  it("stops at the default attempt budget", async () => {
    const timer = new FakeTimer();
    const attempt = vi.fn(async () => {
      throw new Error("down");
    });
    const controller = new ReconnectController(attempt, { timer, random: () => 0 });

    controller.notifyLoss();
    for (let i = 0; i < RECONNECT_MAX_ATTEMPTS; i++) await timer.fire();

    expect(attempt).toHaveBeenCalledTimes(RECONNECT_MAX_ATTEMPTS);
    expect(timer.scheduled).toBe(0);
  });

  it("ignores a second loss report while a loop is already running", async () => {
    const timer = new FakeTimer();
    const attempt = vi.fn(async () => {
      throw new Error("down");
    });
    const controller = new ReconnectController(attempt, { timer, random: () => 1 });

    controller.notifyLoss();
    controller.notifyLoss();
    await timer.fire();

    // Two loops would double the connection rate exactly when the server is
    // struggling to come back.
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("runs the resync hook and resets the budget after a successful attempt", async () => {
    const timer = new FakeTimer();
    const resync = vi.fn();
    const controller = new ReconnectController(async () => undefined, {
      timer,
      random: () => 1,
      onResync: resync,
    });

    controller.notifyLoss();
    await timer.fire();

    // The caller has to be able to throw away its stale world here, before the
    // first fresh snapshot is drawn.
    expect(resync).toHaveBeenCalledWith(1);
    expect(controller.attempts).toBe(0);
    expect(controller.active).toBe(false);
  });

  it("cancels the pending retry when the connection comes back on its own", async () => {
    const timer = new FakeTimer();
    const attempt = vi.fn(async () => undefined);
    const controller = new ReconnectController(attempt, { timer });

    controller.notifyLoss();
    expect(timer.scheduled).toBe(1);
    controller.notifyConnected();

    // A retry that fires after a live connection tears it straight back down.
    expect(timer.scheduled).toBe(0);
    expect(controller.active).toBe(false);
  });

  it("stop() abandons the loop without notifying anyone", async () => {
    const timer = new FakeTimer();
    const giveUp = vi.fn();
    const resync = vi.fn();
    const attempt = vi.fn(async () => undefined);
    const controller = new ReconnectController(attempt, { timer, onGiveUp: giveUp, onResync: resync });

    controller.notifyLoss();
    controller.stop();
    expect(timer.scheduled).toBe(0);

    await flush();
    expect(attempt).not.toHaveBeenCalled();
    expect(giveUp).not.toHaveBeenCalled();
    expect(resync).not.toHaveBeenCalled();
    expect(controller.active).toBe(false);
  });

  it("reports the attempt as in flight until it settles", async () => {
    const timer = new FakeTimer();
    const gate = deferred();
    const controller = new ReconnectController(() => gate.promise, { timer });

    controller.notifyLoss();
    const fired = timer.fire();
    await flush();
    expect(controller.connecting).toBe(true);

    gate.open();
    await fired;
    expect(controller.connecting).toBe(false);
    expect(controller.active).toBe(false);
  });
});
