/**
 * Reconnection policy for a dropped cable, and the resync that must follow it.
 *
 * Backoff is exponential from 500 ms, doubling, capped at 15 s, with *full
 * jitter* — the actual wait is `random() * min(cap, base * factor^n)` rather
 * than the raw exponential. Full jitter is the variant that actually
 * de-synchronises a thundering herd of clients after a server restart; a fixed
 * schedule just replays the same collision one second later. A hard attempt
 * budget stops a client from reconnecting forever against a server that is
 * genuinely gone.
 *
 * The resync path is the part that matters for correctness. A reconnect lands
 * us in the middle of a match whose world has moved on: our snapshot buffer and
 * every predicted position describe a past that no longer exists. Re-subscribing
 * to `game:<id>` makes the server run its `subscribed` hook again, which
 * re-broadcasts `game:start` and begins a fresh full-table snapshot stream
 * (PROTOCOL.md §3, §5 — full tables are what make reconnects free). Before that
 * stream lands, `onResync` discards the stale state, so the renderer never draws
 * a ghost from before the drop.
 *
 * One subtlety this class owns: the transport reports "connected" from inside
 * the attempt this controller started. If that cancelled the loop before the
 * attempt resolved, the resync would never run — which is precisely how a
 * reconnect ends up drawing the pre-drop world. So `notifyConnected` only
 * clears the *pending retry*, never the in-flight attempt, and the resync is
 * driven by the attempt's own resolution.
 */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_FACTOR = 2;
export const RECONNECT_CAP_MS = 15_000;
export const RECONNECT_MAX_ATTEMPTS = 10;

/** Opaque timer token; the default timer API is swappable for tests. */
export type TimerHandle = number;

export interface TimerApi {
  set(handler: () => void, delayMs: number): TimerHandle;
  clear(handle: TimerHandle): void;
}

export interface ReconnectOptions {
  /** First backoff window, ms. */
  baseMs?: number;
  /** Growth factor per attempt. */
  factor?: number;
  /** Upper bound on a single wait, ms. */
  capMs?: number;
  /** Attempts before `onGiveUp` fires. */
  maxAttempts?: number;
  /** Uniform [0, 1) source for full jitter. Injectable for determinism. */
  random?: () => number;
  /** Timer source. Injectable so a test can drive backoff without waiting. */
  timer?: TimerApi;
  /** Fired before each attempt with the 1-based attempt number. */
  onAttempt?: (attempt: number, delayMs: number) => void;
  /** Fired once the attempt budget is exhausted. */
  onGiveUp?: (attempts: number) => void;
  /**
   * Runs after a successful reconnect and *before* the caller resumes play.
   * Discard snapshot and prediction state here, then re-subscribe.
   */
  onResync?: (attempt: number) => void;
}

/** The real timer, used unless a caller injects its own. */
export const systemTimer: TimerApi = {
  set: (handler, delayMs) => setTimeout(handler, delayMs) as unknown as TimerHandle,
  clear: (handle) => clearTimeout(handle),
};

export class ReconnectController {
  private readonly baseMs: number;
  private readonly factor: number;
  private readonly capMs: number;
  private readonly maxAttempts: number;
  private readonly random: () => number;
  private readonly timer: TimerApi;
  private readonly attemptFn: (attempt: number) => Promise<void>;
  private readonly onAttempt: ((attempt: number, delayMs: number) => void) | null;
  private readonly onGiveUp: ((attempts: number) => void) | null;
  private readonly onResync: ((attempt: number) => void) | null;
  private handle: TimerHandle | null = null;
  private attemptCount = 0;
  private running = false;
  private inFlight = false;
  /** Set by {@link ReconnectController.stop}: never resync after a real quit. */
  private stopped = false;

  constructor(attempt: (attempt: number) => Promise<void>, options: ReconnectOptions = {}) {
    this.attemptFn = attempt;
    this.baseMs = Math.max(1, options.baseMs ?? RECONNECT_BASE_MS);
    this.factor = Math.max(1, options.factor ?? RECONNECT_FACTOR);
    this.capMs = Math.max(this.baseMs, options.capMs ?? RECONNECT_CAP_MS);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? RECONNECT_MAX_ATTEMPTS);
    this.random = options.random ?? Math.random;
    this.timer = options.timer ?? systemTimer;
    this.onAttempt = options.onAttempt ?? null;
    this.onGiveUp = options.onGiveUp ?? null;
    this.onResync = options.onResync ?? null;
  }

  /** Attempts made since the last successful connection. */
  get attempts(): number {
    return this.attemptCount;
  }

  /** True while a backoff retry is pending. */
  get active(): boolean {
    return this.running;
  }

  /** True while a connect attempt is in flight. */
  get connecting(): boolean {
    return this.inFlight;
  }

  /**
   * True while this controller owns the connection: a retry is pending or an
   * attempt is in flight. Callers use it to avoid re-subscribing behind the
   * resync's back.
   */
  get recovering(): boolean {
    return this.running || this.inFlight;
  }

  /**
   * The deterministic, un-jittered wait before `attempt` (1-based). Exposed so a
   * test or a debug overlay can show the ceiling without consuming randomness.
   */
  backoffMs(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    return Math.min(this.capMs, this.baseMs * Math.pow(this.factor, exponent));
  }

  /** The actual wait, with full jitter applied. */
  jitteredBackoffMs(attempt: number): number {
    return Math.round(this.random() * this.backoffMs(attempt));
  }

  /**
   * Reports that the connection dropped. Schedules the first attempt; calling it
   * again while a loop is running is a no-op, so transport state changes and
   * manual retries can both drive it safely.
   */
  notifyLoss(): void {
    if (this.running) return;
    this.stopped = false;
    this.running = true;
    this.attemptCount = 0;
    this.scheduleNext();
  }

  /**
   * Reports a live connection: cancels the pending retry and resets the budget.
   * The in-flight flag is deliberately left alone — a transport that reports
   * "connected" from inside our own attempt must not cancel the resync that
   * follows it.
   */
  notifyConnected(): void {
    this.cancelTimer();
    this.running = false;
    this.attemptCount = 0;
  }

  /** Abandons reconnection without notifying anyone — an explicit disconnect. */
  stop(): void {
    this.cancelTimer();
    this.stopped = true;
    this.running = false;
    this.inFlight = false;
  }

  /* ------------------------------------------------------------- internals */

  private scheduleNext(): void {
    const attempt = this.attemptCount + 1;
    const delayMs = this.jitteredBackoffMs(attempt);
    this.onAttempt?.(attempt, delayMs);
    this.handle = this.timer.set(() => {
      this.handle = null;
      void this.run(attempt);
    }, delayMs);
  }

  private async run(attempt: number): Promise<void> {
    if (this.stopped || !this.running) return;
    if (attempt > this.maxAttempts) {
      this.giveUp(attempt - 1);
      return;
    }
    this.inFlight = true;
    try {
      await this.attemptFn(attempt);
    } catch {
      this.inFlight = false;
      if (this.stopped || !this.running) return;
      this.attemptCount = attempt;
      if (attempt >= this.maxAttempts) {
        this.giveUp(attempt);
        return;
      }
      this.scheduleNext();
      return;
    }
    this.inFlight = false;
    this.running = false;
    this.attemptCount = 0;
    if (this.stopped) return;
    // Success: the caller still has to throw away its stale world state before
    // the first fresh snapshot is drawn.
    this.onResync?.(attempt);
  }

  private giveUp(attempts: number): void {
    this.cancelTimer();
    this.running = false;
    this.inFlight = false;
    this.attemptCount = attempts;
    this.onGiveUp?.(attempts);
  }

  private cancelTimer(): void {
    if (this.handle === null) return;
    this.timer.clear(this.handle);
    this.handle = null;
  }
}
