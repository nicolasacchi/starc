/**
 * Rolling-window netcode metrics for the in-game stats overlay.
 *
 * Every series is a fixed-capacity ring of `Float64Array`s allocated once in the
 * constructor, so the collector's footprint is constant however long the session
 * runs: a ten-minute match holds exactly `window` samples per series and
 * nothing more. Nothing here allocates after construction except the report
 * object and the percentile scratch copy, both produced only when the overlay
 * asks for one.
 *
 * What is measured and why:
 *
 * - **rtt** — from writing a STOMP frame with a `receipt` to its `RECEIPT`
 *   coming back. The most honest end-to-end number available, because it
 *   traverses the same socket as gameplay traffic.
 * - **snapshotInterval / jitter** — spacing between consecutive snapshots
 *   against the 10 Hz nominal cadence, and the mean absolute deviation from it.
 * - **commandLatency** — from issuing a batch to the snapshot whose `ack` covers
 *   its `from_tick`: how long a click takes to become server truth.
 * - **packetsPerSecond** — inbound frames over the last second.
 * - **snapshotBytes** — serialised snapshot size: the number that decides
 *   whether bandwidth or parsing is the bottleneck.
 * - **interpolationDelay** — how far the render clock trails the newest
 *   snapshot; the knob trading latency against smoothness.
 * - **predictionError** — metres our own-unit prediction was off when a snapshot
 *   re-based it. A rising series means the local model is lying.
 * - **droppedFrames** — frames over budget, as a fraction of frames seen.
 */
import { SNAPSHOT_HZ } from "@shared/protocol";

/** Samples retained per series. 120 ≈ 12 s at 10 Hz. */
export const DEFAULT_WINDOW = 120;

export interface MetricsTotals {
  snapshots: number;
  commands: number;
  receipts: number;
  frames: number;
}

export interface MetricsReport {
  /** Round-trip time over the window: mean, 95th percentile, worst. */
  rttMs: number;
  rttP95Ms: number;
  rttMaxMs: number;
  /** Mean gap between snapshots, and mean absolute deviation from nominal. */
  snapshotIntervalMs: number;
  snapshotJitterMs: number;
  /** Click → server-truth latency, ms. */
  commandLatencyMs: number;
  packetsPerSecond: number;
  snapshotBytes: number;
  /** Render clock lag behind the newest snapshot, ms. */
  interpolationDelayMs: number;
  /** Mean absolute prediction error, metres. */
  predictionErrorM: number;
  droppedFrames: number;
  framesPerSecond: number;
  /** Samples currently held in the shortest series (never exceeds `window`). */
  samples: number;
  /** Lifetime counters since construction or the last `reset()`. */
  totals: MetricsTotals;
}

/** Fixed-capacity rolling window over a numeric series. */
class Ring {
  private readonly values: Float64Array;
  private write = 0;
  private filled = 0;
  private sum = 0;
  private scratch = new Float64Array(0);

  constructor(readonly capacity: number) {
    this.values = new Float64Array(capacity);
    this.scratch = new Float64Array(capacity);
  }

  get count(): number {
    return this.filled;
  }

  push(value: number): void {
    if (!Number.isFinite(value)) return;
    if (this.filled === this.capacity) this.sum -= this.values[this.write];
    else this.filled++;
    this.values[this.write] = value;
    this.sum += value;
    this.write = (this.write + 1) % this.capacity;
  }

  mean(): number {
    return this.filled === 0 ? 0 : this.sum / this.filled;
  }

  total(): number {
    return this.sum;
  }

  max(): number {
    if (this.filled === 0) return 0;
    let best = -Infinity;
    for (let i = 0; i < this.filled; i++) if (this.values[i] > best) best = this.values[i];
    return best;
  }

  /** Counts values at or above `floor`, over the whole window. */
  countAtOrAbove(floor: number): number {
    let hits = 0;
    for (let i = 0; i < this.filled; i++) if (this.values[i] >= floor) hits++;
    return hits;
  }

  /** Copies the live window into the scratch buffer and sorts it. */
  private sortedScratch(): Float64Array {
    for (let i = 0; i < this.filled; i++) this.scratch[i] = this.values[i];
    this.scratch.subarray(0, this.filled).sort();
    return this.scratch;
  }

  /** Percentile with nearest-rank, `p` in [0, 1]. */
  percentile(p: number): number {
    if (this.filled === 0) return 0;
    const sorted = this.sortedScratch();
    const rank = Math.min(this.filled - 1, Math.max(0, Math.round((this.filled - 1) * p)));
    return sorted[rank];
  }

  clear(): void {
    this.values.fill(0);
    this.scratch.fill(0);
    this.write = 0;
    this.filled = 0;
    this.sum = 0;
  }
}

/**
 * Bounded FIFO of in-flight command batches awaiting their `ack`. The server
 * echoes the highest `from_tick` it has processed, so the answer to "how long
 * did my click take" is the age of the oldest still-pending batch it covers.
 */
class PendingAcks {
  private readonly ticks: Float64Array;
  private readonly stamps: Float64Array;
  private head = 0;
  private size = 0;
  private next = 0;

  constructor(capacity: number) {
    this.ticks = new Float64Array(capacity);
    this.stamps = new Float64Array(capacity);
  }

  push(tick: number, sentAtMs: number): void {
    if (this.size === this.ticks.length) this.head = (this.head + 1) % this.ticks.length;
    else this.size++;
    this.ticks[this.next] = tick;
    this.stamps[this.next] = sentAtMs;
    this.next = (this.next + 1) % this.ticks.length;
  }

  /** Age of the oldest still-pending batch covered by `ack`, or -1 if none. */
  latencyForAck(ack: number, nowMs: number): number {
    let oldest = -1;
    for (let i = 0; i < this.size; i++) {
      const slot = (this.head + i) % this.ticks.length;
      if (this.ticks[slot] > ack) continue;
      if (oldest < 0 || this.stamps[slot] < oldest) oldest = this.stamps[slot];
    }
    return oldest < 0 ? -1 : nowMs - oldest;
  }

  clear(): void {
    this.ticks.fill(0);
    this.stamps.fill(0);
    this.head = 0;
    this.size = 0;
    this.next = 0;
  }
}

export interface NetMetricsOptions {
  /** Samples retained per series. */
  window?: number;
  /** In-flight command batches tracked for ack latency. */
  pendingCapacity?: number;
  /** Frame time above which a frame counts as dropped, ms. */
  droppedFrameMs?: number;
}

export class NetMetrics {
  readonly window: number;
  private readonly droppedFrameMs: number;
  private readonly rtt: Ring;
  private readonly snapshotInterval: Ring;
  private readonly snapshotJitter: Ring;
  private readonly commandLatency: Ring;
  private readonly snapshotBytes: Ring;
  private readonly interpolationDelay: Ring;
  private readonly predictionError: Ring;
  private readonly frameMs: Ring;
  private readonly droppedFrames: Ring;
  private readonly inboundPackets: Ring;
  private readonly pendingAcks: PendingAcks;
  private lastSnapshotAtMs = 0;
  private lastReceiptSentAtMs = 0;
  private snapshotCount = 0;
  private commandCount = 0;
  private receiptCount = 0;
  private frameCount = 0;

  constructor(options: NetMetricsOptions = {}) {
    this.window = Math.max(8, Math.floor(options.window ?? DEFAULT_WINDOW));
    this.droppedFrameMs = options.droppedFrameMs ?? 50;
    this.rtt = new Ring(this.window);
    this.snapshotInterval = new Ring(this.window);
    this.snapshotJitter = new Ring(this.window);
    this.commandLatency = new Ring(this.window);
    this.snapshotBytes = new Ring(this.window);
    this.interpolationDelay = new Ring(this.window);
    this.predictionError = new Ring(this.window);
    this.frameMs = new Ring(this.window);
    this.droppedFrames = new Ring(this.window);
    this.inboundPackets = new Ring(this.window);
    this.pendingAcks = new PendingAcks(Math.max(8, Math.floor(options.pendingCapacity ?? 64)));
  }

  /** A STOMP frame carrying a `receipt` was written to the socket. */
  recordReceiptSent(sentAtMs: number = Date.now()): void {
    this.lastReceiptSentAtMs = sentAtMs;
  }

  /** The matching `RECEIPT` frame came back: this is the round-trip time. */
  recordReceiptReceived(nowMs: number = Date.now()): void {
    this.receiptCount++;
    if (this.lastReceiptSentAtMs > 0) this.rtt.push(nowMs - this.lastReceiptSentAtMs);
    this.inboundPackets.push(nowMs);
  }

  /** A snapshot arrived; `bytes` is its serialised length. */
  recordSnapshot(receivedAtMs: number, bytes: number): void {
    if (this.lastSnapshotAtMs > 0) {
      const gap = receivedAtMs - this.lastSnapshotAtMs;
      this.snapshotInterval.push(gap);
      this.snapshotJitter.push(Math.abs(gap - 1000 / SNAPSHOT_HZ));
    }
    this.lastSnapshotAtMs = receivedAtMs;
    this.snapshotBytes.push(bytes);
    this.snapshotCount++;
    this.inboundPackets.push(receivedAtMs);
  }

  /** A command batch was handed to the transport, stamped with `fromTick`. */
  recordCommandSent(fromTick: number, sentAtMs: number = Date.now()): void {
    this.commandCount++;
    this.pendingAcks.push(fromTick, sentAtMs);
  }

  /** A snapshot reported `ack`; resolves the command latency series. */
  recordAck(ack: number, nowMs: number = Date.now()): void {
    const latency = this.pendingAcks.latencyForAck(ack, nowMs);
    if (latency >= 0) this.commandLatency.push(latency);
  }

  /** Render clock lag behind the newest snapshot. */
  recordInterpolationDelay(delayMs: number): void {
    this.interpolationDelay.push(delayMs);
  }

  /** Distance our own-unit prediction was off when a snapshot re-based it. */
  recordPredictionError(metres: number): void {
    this.predictionError.push(metres);
  }

  /** One animation frame. Anything slower than `droppedFrameMs` is a drop. */
  recordFrame(deltaMs: number): void {
    this.frameCount++;
    this.frameMs.push(deltaMs);
    this.droppedFrames.push(deltaMs > this.droppedFrameMs ? 1 : 0);
  }

  /** Builds the report. `nowMs` drives the packets-per-second window. */
  snapshot(nowMs: number = Date.now()): MetricsReport {
    const frames = this.frameMs.count;
    const frameSpanMs = this.frameMs.total();
    const packetsLastSecond = this.inboundPackets.countAtOrAbove(nowMs - 1000);
    return {
      rttMs: this.rtt.mean(),
      rttP95Ms: this.rtt.percentile(0.95),
      rttMaxMs: this.rtt.max(),
      snapshotIntervalMs: this.snapshotInterval.mean(),
      snapshotJitterMs: this.snapshotJitter.mean(),
      commandLatencyMs: this.commandLatency.mean(),
      packetsPerSecond: packetsLastSecond,
      snapshotBytes: this.snapshotBytes.mean(),
      interpolationDelayMs: this.interpolationDelay.mean(),
      predictionErrorM: this.predictionError.mean(),
      droppedFrames: frames > 0 ? this.droppedFrames.total() / frames : 0,
      framesPerSecond: frameSpanMs > 0 ? (frames * 1000) / frameSpanMs : 0,
      samples: this.rtt.count,
      totals: {
        snapshots: this.snapshotCount,
        commands: this.commandCount,
        receipts: this.receiptCount,
        frames: this.frameCount,
      },
    };
  }

  /** One-line summary for the overlay. */
  format(nowMs: number = Date.now()): string {
    const r = this.snapshot(nowMs);
    return (
      `rtt ${r.rttMs.toFixed(0)}/${r.rttP95Ms.toFixed(0)}ms` +
      ` · snap ${r.snapshotIntervalMs.toFixed(0)}±${r.snapshotJitterMs.toFixed(0)}ms` +
      ` · cmd ${r.commandLatencyMs.toFixed(0)}ms` +
      ` · ${r.packetsPerSecond.toFixed(0)} pkt/s` +
      ` · ${(r.snapshotBytes / 1024).toFixed(1)}kB` +
      ` · interp ${r.interpolationDelayMs.toFixed(0)}ms` +
      ` · pred ${r.predictionErrorM.toFixed(2)}m` +
      ` · drop ${(r.droppedFrames * 100).toFixed(1)}%` +
      ` · ${r.framesPerSecond.toFixed(0)} fps`
    );
  }

  /** Clears every window and counter; called on disconnect and resync. */
  reset(): void {
    this.rtt.clear();
    this.snapshotInterval.clear();
    this.snapshotJitter.clear();
    this.commandLatency.clear();
    this.snapshotBytes.clear();
    this.interpolationDelay.clear();
    this.predictionError.clear();
    this.frameMs.clear();
    this.droppedFrames.clear();
    this.inboundPackets.clear();
    this.pendingAcks.clear();
    this.lastSnapshotAtMs = 0;
    this.lastReceiptSentAtMs = 0;
    this.snapshotCount = 0;
    this.commandCount = 0;
    this.receiptCount = 0;
    this.frameCount = 0;
  }
}
