/**
 * The stats overlay reads these series; nothing else in the client does. The
 * property that matters is that the collector's footprint is constant: a
 * rolling window that quietly grew would turn a ten-minute match into a leak
 * nobody notices until the tab dies.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_WINDOW, NetMetrics } from "./metrics";

describe("NetMetrics", () => {
  it("retains at most one window of round-trip samples", () => {
    const metrics = new NetMetrics();
    for (let i = 0; i < 100_000; i++) metrics.recordReceipt(i, i + 20);

    const report = metrics.snapshot();
    expect(report.samples).toBe(DEFAULT_WINDOW);
    // Lifetime counters keep counting; only the window is bounded.
    expect(report.totals.receipts).toBe(100_000);
  });

  it("reports the mean of the retained window, not of the whole session", () => {
    const metrics = new NetMetrics({ window: 8 });
    for (let i = 0; i < 1_000; i++) metrics.recordReceipt(i, i + 100);
    for (let i = 0; i < 8; i++) metrics.recordReceipt(i, i + 10);

    // A session-long mean would still read ~100 ms and hide the improvement.
    expect(metrics.snapshot().rttMs).toBeCloseTo(10, 9);
  });

  it("forgets a round-trip spike once it rolls out of the window", () => {
    const metrics = new NetMetrics({ window: 8 });
    for (let i = 0; i < 1_000; i++) metrics.recordReceipt(i, i + 1_000);
    expect(metrics.snapshot().rttMaxMs).toBe(1_000);

    for (let i = 0; i < 8; i++) metrics.recordReceipt(i, i + 5);
    // A spike from four minutes ago must not sit in the overlay forever.
    expect(metrics.snapshot().rttMaxMs).toBe(5);
  });

  it("keeps the jitter series bounded so it reflects the current connection", () => {
    const metrics = new NetMetrics({ window: 8 });
    // A clean 10 Hz stream for a while, then a stuttering one.
    for (let i = 1; i <= 100; i++) metrics.recordSnapshot(i * 100, 1_000);
    for (let i = 1; i <= 200; i++) metrics.recordSnapshot(10_000 + i * 500, 1_000);

    // |500 - 100| for the whole window, not diluted by the earlier 0 ms gaps.
    expect(metrics.snapshot().snapshotJitterMs).toBeCloseTo(400, 6);
    expect(metrics.snapshot().snapshotIntervalMs).toBeCloseTo(500, 6);
  });

  it("ignores samples that are not finite", () => {
    const metrics = new NetMetrics({ window: 8 });
    metrics.recordReceipt(0, 20);
    metrics.recordReceipt(Number.NaN, 0);
    expect(metrics.snapshot().samples).toBe(1);
  });

  it("counts a click as slow only from the snapshot that acknowledges it", () => {
    const metrics = new NetMetrics();
    metrics.recordCommandSent(5, 1_000);
    metrics.recordCommandSent(6, 1_010);
    metrics.recordAck(5, 1_200);

    // The oldest newly-acked batch is the one the player is waiting on.
    expect(metrics.snapshot().commandLatencyMs).toBe(200);
  });

  it("does not re-report a latency for an already acknowledged batch", () => {
    const metrics = new NetMetrics();
    metrics.recordCommandSent(5, 1_000);
    metrics.recordAck(5, 1_200);
    metrics.recordAck(5, 1_400);

    // Counting the same click twice would report a click→truth time of 400 ms.
    expect(metrics.snapshot().commandLatencyMs).toBe(200);
  });

  it("counts only inbound packets from the last second", () => {
    const metrics = new NetMetrics();
    for (let i = 0; i < 10; i++) metrics.recordSnapshot(i * 100, 500); // 0..900 ms
    for (let i = 0; i < 3; i++) metrics.recordReceipt(0, 5_000 + i * 10);

    const report = metrics.snapshot(6_000);
    expect(report.packetsPerSecond).toBe(3);
  });

  it("reports the dropped-frame fraction over the retained frames", () => {
    const metrics = new NetMetrics({ window: 10 });
    for (let i = 0; i < 9; i++) metrics.recordFrame(16);
    metrics.recordFrame(120);

    expect(metrics.snapshot().droppedFrames).toBeCloseTo(0.1, 9);
  });

  it("averages frames per second over the retained frame times", () => {
    const metrics = new NetMetrics({ window: 10 });
    for (let i = 0; i < 10; i++) metrics.recordFrame(20); // 50 fps

    expect(metrics.snapshot().framesPerSecond).toBeCloseTo(50, 6);
  });

  it("ignores a frame delta that is not a real duration", () => {
    const metrics = new NetMetrics();
    metrics.recordFrame(0);
    // A negative delta from a clock step would drag the mean below zero.
    expect(metrics.snapshot().droppedFrames).toBe(0);
    expect(Number.isFinite(metrics.snapshot().framesPerSecond)).toBe(true);
  });

  it("reset clears every window and counter", () => {
    const metrics = new NetMetrics();
    metrics.recordReceipt(0, 100);
    metrics.recordFrame(16);
    metrics.recordSnapshot(1_000, 500);
    metrics.recordCommandSent(1, 1_000);
    metrics.recordPredictionError(3);
    metrics.recordInterpolationDelay(200);

    metrics.reset();
    const report = metrics.snapshot();
    expect(report.samples).toBe(0);
    expect(report.rttMs).toBe(0);
    expect(report.totals).toEqual({ snapshots: 0, commands: 0, receipts: 0, frames: 0 });
    expect(report.predictionErrorM).toBe(0);
    expect(report.interpolationDelayMs).toBe(0);
  });

  it("formats a one-line summary for the overlay", () => {
    const metrics = new NetMetrics();
    metrics.recordReceipt(0, 20);
    const line = metrics.format(1_000);
    expect(line).toContain("rtt 20/");
    expect(line).toContain("fps");
  });

  it("raises a tiny window to the floor rather than dividing by nothing", () => {
    const metrics = new NetMetrics({ window: 1 });
    expect(metrics.window).toBe(8);
    for (let i = 0; i < 50; i++) metrics.recordReceipt(i, i + 20);
    expect(metrics.snapshot().samples).toBe(8);
  });
});
