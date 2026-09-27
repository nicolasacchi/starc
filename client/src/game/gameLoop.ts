/**
 * The frame clock.
 *
 * Rendering happens at whatever rate the display offers; the simulation must
 * not. This loop keeps the two apart: wall-clock deltas are clamped and then
 * drained in fixed `step` increments, so a slow frame costs catch-up steps
 * rather than a longer — and therefore different — timestep.
 *
 * Three guards keep a backgrounded tab or a stalled socket from spiralling:
 *
 * - `maxDelta` clamps a single frame's wall delta (default 250 ms), so a tab
 *   that was hidden for a minute does not try to catch up a minute of
 *   simulation in one frame.
 * - `maxCatchUpSteps` bounds the sub-steps a single frame may run (default 5),
 *   so even after the clamp a frame can never monopolise the main thread.
 * - Whatever cannot be consumed is dropped from the accumulator rather than
 *   carried forward, which is what stops the leftover from re-accumulating
 *   into the next frame forever.
 *
 * `update` runs once per fixed sub-step (its `dt` is always `step`), and
 * `render` — if supplied — runs exactly once per frame. Nothing allocates
 * inside the frame callback: the frame-time ring is allocated once, and the
 * timestamp source and rAF pair are injected so a headless test can drive the
 * loop deterministically.
 */

/** Fixed simulation step for client-side prediction and animation, seconds. */
export const DEFAULT_STEP_SECONDS = 1 / 60;

/** Longest wall delta a single frame may contribute, seconds. */
export const DEFAULT_MAX_DELTA = 0.25;

/** Most fixed sub-steps a single frame may run. */
export const DEFAULT_MAX_CATCH_UP_STEPS = 5;

/** Frames averaged for the reported frame rate. */
const FPS_WINDOW = 60;

export interface GameLoopOptions {
  /** Runs once per fixed sub-step with the fixed `dt`. */
  update: (dt: number, frameDt: number) => void;
  /** Runs once per frame after the sub-steps, with the clamped frame delta. */
  render?: (frameDt: number) => void;
  /** Fixed step size, default 1/60 s. */
  step?: number;
  maxCatchUpSteps?: number;
  maxDelta?: number;
  /** Monotonic millisecond clock; default `performance.now()` or `Date.now()`. */
  now?: () => number;
  /** Frame scheduler; defaults to `requestAnimationFrame` or a 16 ms timer. */
  raf?: (cb: (timeMs: number) => void) => number;
  caf?: (handle: number) => void;
}

export class GameLoop {
  private readonly update: (dt: number, frameDt: number) => void;
  private readonly render: ((frameDt: number) => void) | null;
  private readonly step: number;
  private readonly maxCatchUpSteps: number;
  private readonly maxDelta: number;
  private readonly now: () => number;
  private readonly raf: (cb: (timeMs: number) => void) => number;
  private readonly caf: (handle: number) => void;

  private readonly frameTimes = new Float64Array(FPS_WINDOW);
  private frameCursor = 0;
  private frameCount = 0;
  private frameTimeSum = 0;
  private fpsValue = 0;

  private handle = 0;
  private isRunning = false;
  private accumulator = 0;
  private lastMs = 0;
  private droppedSeconds = 0;

  constructor(opts: GameLoopOptions) {
    this.update = opts.update;
    this.render = opts.render ?? null;
    this.step = Math.max(1e-4, opts.step ?? DEFAULT_STEP_SECONDS);
    this.maxCatchUpSteps = Math.max(1, Math.floor(opts.maxCatchUpSteps ?? DEFAULT_MAX_CATCH_UP_STEPS));
    this.maxDelta = Math.max(this.step, opts.maxDelta ?? DEFAULT_MAX_DELTA);
    this.now = opts.now ?? defaultNow;
    const sched = opts.raf !== undefined && opts.caf !== undefined
      ? { raf: opts.raf, caf: opts.caf }
      : defaultScheduler();
    this.raf = sched.raf;
    this.caf = sched.caf;
  }

  get running(): boolean {
    return this.isRunning;
  }

  /** Frames per second, averaged over the last {@link FPS_WINDOW} frames. */
  get fps(): number {
    return this.fpsValue;
  }

  /** Simulation seconds abandoned to clamping, i.e. the spiral the guard ate. */
  get droppedSeconds(): number {
    return this.droppedSeconds;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.accumulator = 0;
    this.droppedSeconds = 0;
    this.lastMs = this.now();
    this.handle = this.raf(this.frame);
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.caf(this.handle);
    this.handle = 0;
    this.accumulator = 0;
  }

  /**
   * Advances the loop by one frame worth of wall time. Exposed so a headless
   * caller can step the loop without a real animation frame; `stop()` still
   * cancels the scheduled rAF.
   */
  stepFrame(nowMs: number): void {
    if (!this.isRunning) return;
    const frameDt = this.advance(nowMs);
    let steps = Math.floor(this.accumulator / this.step);
    if (steps > this.maxCatchUpSteps) {
      steps = this.maxCatchUpSteps;
      const overflow = (this.accumulator - steps * this.step) / 1000;
      this.accumulator = 0;
      this.droppedSeconds += overflow > 0 ? overflow : 0;
    } else {
      this.accumulator -= steps * this.step;
    }
    for (let i = 0; i < steps; i++) this.update(this.step, frameDt);
    this.render?.(frameDt);
  }

  private readonly frame = (timeMs: number): void => {
    if (!this.isRunning) return;
    this.handle = this.raf(this.frame);
    this.stepFrame(timeMs);
  };

  /** Clamped wall delta in seconds since the previous frame. */
  private advance(nowMs: number): number {
    const raw = (nowMs - this.lastMs) / 1000;
    this.lastMs = nowMs;
    const frameDt = raw > 0 ? (raw > this.maxDelta ? this.maxDelta : raw) : 0;
    this.accumulator += frameDt;
    this.recordFrame(raw);
    return frameDt;
  }

  private recordFrame(rawSeconds: number): void {
    if (this.frameCount === FPS_WINDOW) this.frameTimeSum -= this.frameTimes[this.frameCursor];
    else this.frameCount++;
    this.frameTimes[this.frameCursor] = rawSeconds;
    this.frameTimeSum += rawSeconds;
    this.frameCursor = (this.frameCursor + 1) % FPS_WINDOW;
    this.fpsValue = this.frameTimeSum > 0 ? this.frameCount / this.frameTimeSum : 0;
  }
}

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function defaultScheduler(): { raf: (cb: (timeMs: number) => void) => number; caf: (h: number) => void } {
  if (typeof requestAnimationFrame === "function") {
    return {
      raf: (cb) => requestAnimationFrame(cb),
      caf: (h) => cancelAnimationFrame(h),
    };
  }
  // Node, and any environment without a display: a 60 Hz timer keeps the loop
  // drivable instead of silently doing nothing. Under this project's lib set
  // `setTimeout` hands back the DOM `number` handle.
  return {
    raf: (cb) => setTimeout(() => cb(defaultNow()), 16),
    caf: (h) => clearTimeout(h),
  };
}
