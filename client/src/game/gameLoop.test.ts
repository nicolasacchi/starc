/**
 * The frame clock keeps rendering and simulation apart. The failure modes are
 * all felt rather than seen: a backgrounded tab that tries to catch up a minute
 * of simulation in one frame and locks the tab up, or a `stop()` that leaves
 * the loop running and keeps burning frames after the screen is gone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  DEFAULT_MAX_CATCH_UP_STEPS,
  DEFAULT_MAX_DELTA,
  DEFAULT_STEP_SECONDS,
  GameLoop,
} from "./gameLoop";
import type { GameLoopOptions } from "./gameLoop";

/** A rAF pair the test drives by hand; nothing here touches a real display. */
function fakeScheduler() {
  const queued: ((timeMs: number) => void)[] = [];
  const cancelled: number[] = [];
  let next = 1;
  return {
    raf: (cb: (timeMs: number) => void): number => {
      queued.push(cb);
      return next++;
    },
    caf: (handle: number): void => {
      cancelled.push(handle);
    },
    /** Fires the pending frame callback, as the browser would. */
    fire(timeMs: number): void {
      const cb = queued.shift();
      if (!cb) throw new Error("no frame is scheduled");
      cb(timeMs);
    },
    get pending(): number {
      return queued.length;
    },
    get cancelled(): readonly number[] {
      return cancelled;
    },
  };
}

describe("GameLoop", () => {
  let raf: ReturnType<typeof fakeScheduler>;
  let update: Mock<(dt: number, frameDt: number) => void>;
  let render: Mock<(frameDt: number) => void>;
  let clock: number;

  function makeLoop(options: Partial<GameLoopOptions> = {}): GameLoop {
    return new GameLoop({
      update,
      render,
      now: () => clock,
      raf: raf.raf,
      caf: raf.caf,
      ...options,
    });
  }

  beforeEach(() => {
    raf = fakeScheduler();
    update = vi.fn<(dt: number, frameDt: number) => void>();
    render = vi.fn<(frameDt: number) => void>();
    clock = 0;
  });

  it("schedules a frame on start and does nothing before it", () => {
    const loop = makeLoop();
    expect(loop.running).toBe(false);

    expect(raf.pending).toBe(0);
    loop.stepFrame(16); // driven before the loop is running
    expect(update).not.toHaveBeenCalled();

    loop.start();
    expect(loop.running).toBe(true);
    expect(raf.pending).toBe(1);
  });

  it("runs the sub-steps and one render per frame", () => {
    const loop = makeLoop({ step: 0.01, maxCatchUpSteps: 10 });
    loop.start();

    raf.fire(50); // a 50 ms frame is five 10 ms steps

    expect(update).toHaveBeenCalledTimes(5);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("always hands update the fixed step, whatever the frame delta was", () => {
    const loop = makeLoop({ step: 0.01, maxCatchUpSteps: 10 });
    loop.start();

    raf.fire(37); // not a multiple of the step

    // A variable timestep here is how prediction drifts away from the server's.
    for (const [dt] of update.mock.calls) expect(dt).toBe(0.01);
    expect(update).toHaveBeenCalledTimes(3);

    // The sub-step remainder carries into the next frame, so the simulation
    // still tracks wall clock instead of losing 7 ms a frame.
    raf.fire(74);
    expect(update).toHaveBeenCalledTimes(7);
  });

  it("does not spiral when a backgrounded tab hands it five seconds", () => {
    const loop = makeLoop({ step: DEFAULT_STEP_SECONDS });
    loop.start();

    raf.fire(5_000);

    // 5 s of 60 Hz simulation is 300 steps; running them all in one frame is
    // the tab-freeze this clamp exists to prevent.
    expect(update.mock.calls.length).toBeLessThanOrEqual(DEFAULT_MAX_CATCH_UP_STEPS);
    // Whatever the clamp could not use is abandoned, not carried forward.
    expect(loop.droppedSeconds).toBeGreaterThan(0);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("clamps a single frame's delta to the configured maximum", () => {
    const loop = makeLoop({ step: 0.01, maxCatchUpSteps: 100, maxDelta: 0.05 });
    loop.start();

    raf.fire(10_000);

    // 5 steps of 10 ms: exactly the clamp, no more.
    expect(update).toHaveBeenCalledTimes(5);
    const [frameDelta] = render.mock.calls[0]!;
    expect(frameDelta).toBe(0.05);
  });

  it("recovers a steady frame rate immediately after a stall", () => {
    const loop = makeLoop({ step: 0.01, maxCatchUpSteps: 5 });
    loop.start();

    raf.fire(5_000);
    const afterStall = update.mock.calls.length;
    raf.fire(5_016);

    // The leftover must not have been carried forward into the next frame.
    expect(update.mock.calls.length).toBe(afterStall + 1);
  });

  it("stops scheduling frames and stops updating once stopped", () => {
    const loop = makeLoop({ step: 0.01, maxCatchUpSteps: 10 });
    loop.start();
    raf.fire(50);
    const before = update.mock.calls.length;

    loop.stop();
    expect(loop.running).toBe(false);
    expect(raf.cancelled).toHaveLength(1);

    loop.stepFrame(1_000);
    expect(update).toHaveBeenCalledTimes(before);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("is safe to stop twice and to start twice", () => {
    const loop = makeLoop();
    loop.start();
    loop.start();
    expect(raf.pending).toBe(1);

    loop.stop();
    loop.stop();
    // A double start would leave two rAF chains racing each other.
    expect(raf.cancelled).toHaveLength(1);
  });

  it("ignores a frame callback that arrives after stop", () => {
    const loop = makeLoop({ step: 0.01, maxCatchUpSteps: 10 });
    loop.start();
    loop.stop();
    // A frame already dispatched by the browser before the cancel took effect.
    raf.fire(50);
    expect(update).not.toHaveBeenCalled();
  });

  it("never lets a frame delta go backwards", () => {
    const loop = makeLoop({ step: 0.01, maxCatchUpSteps: 10 });
    loop.start();
    raf.fire(100);
    update.mockClear();
    render.mockClear();

    loop.stepFrame(50); // the clock jumped backwards

    // Running the simulation backwards would rewind every predicted unit.
    expect(update).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledWith(0);
  });

  it("reports frames per second from the retained frame times", () => {
    const loop = makeLoop({ step: 0.01, maxCatchUpSteps: 10 });
    loop.start();

    for (let i = 1; i <= 10; i++) raf.fire(i * 20);

    expect(loop.fps).toBeCloseTo(50, 6);
  });

  it("works with no render callback at all", () => {
    const loop = new GameLoop({ update, now: () => clock, raf: raf.raf, caf: raf.caf, step: 0.01 });
    loop.start();
    raf.fire(30);
    expect(update).toHaveBeenCalledTimes(3);
  });

  it("defaults to a 60 Hz step and a quarter-second clamp", () => {
    const loop = makeLoop();
    loop.start();
    raf.fire(1_000);
    expect(update.mock.calls[0]![0]).toBe(DEFAULT_STEP_SECONDS);
    expect(DEFAULT_MAX_DELTA).toBe(0.25);
  });
});
