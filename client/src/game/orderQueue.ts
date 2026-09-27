/**
 * Per-entity order queue — the "shift-right-click to queue" model.
 *
 * An entity that already has an order running cannot accept a new one as its
 * current order; it is pushed behind what it is doing. Six orders may sit
 * behind the current one, matching the server's `queue_full` rejection.
 */
import type { Command } from "@shared/protocol";

/** Orders that may be queued behind the one an entity is executing. */
export const MAX_QUEUED_ORDERS = 6;

type WithoutEntity<T> = T extends unknown ? Omit<T, "ids" | "queue" | "worker_id" | "building_id"> : never;

/**
 * A protocol command stripped of the entity it targets: the queue is keyed by
 * entity id, so carrying the id inside the payload would only invite a
 * mismatch between the two.
 */
export type QueuedOrder = WithoutEntity<
  Extract<
    Command,
    { c: "move" | "attack" | "stop" | "hold" | "patrol" | "train" | "build" | "rally" | "harvest" | "ability" }
  >
>;

/** What {@link OrderQueue.push} did with the order it was handed. */
export type PushResult = "current" | "queued" | "rejected";

interface Slot {
  current: QueuedOrder | null;
  queued: QueuedOrder[];
}

/**
 * Expands a queued order back into the wire command for one entity, folding
 * the entity id back in and attaching the `queue` flag.
 */
export function orderCommand(entityId: number, order: QueuedOrder, queue = false): Command {
  switch (order.c) {
    case "move":
      return { c: "move", ids: [entityId], x: order.x, y: order.y, queue };
    case "attack":
      return { c: "attack", ids: [entityId], target_id: order.target_id, queue };
    case "stop":
      return { c: "stop", ids: [entityId] };
    case "hold":
      return { c: "hold", ids: [entityId] };
    case "patrol":
      return { c: "patrol", ids: [entityId], x: order.x, y: order.y, x2: order.x2, y2: order.y2, queue };
    case "train":
      return { c: "train", building_id: entityId, unit_type: order.unit_type, count: order.count ?? 1 };
    case "build":
      return { c: "build", worker_id: entityId, unit_type: order.unit_type, x: order.x, y: order.y };
    case "rally":
      return { c: "rally", building_id: entityId, x: order.x, y: order.y };
    case "harvest":
      return { c: "harvest", worker_id: entityId };
    case "ability":
      return { c: "ability", ids: [entityId], ability: order.ability };
  }
}

export class OrderQueue {
  private readonly slots = new Map<number, Slot>();

  constructor(readonly maxQueued: number = MAX_QUEUED_ORDERS) {}

  /** Entity ids that currently hold a current or queued order. */
  get entityIds(): number[] {
    return [...this.slots.keys()].sort((a, b) => a - b);
  }

  get size(): number {
    return this.slots.size;
  }

  /**
   * Appends an order. It becomes the current order only when the entity is
   * idle (nothing running); otherwise it queues, and is rejected once six
   * orders are already waiting behind.
   */
  push(entityId: number, order: QueuedOrder): PushResult {
    let slot = this.slots.get(entityId);
    if (!slot) {
      slot = emptySlot();
      this.slots.set(entityId, slot);
    }
    if (slot.current === null) {
      slot.current = order;
      return "current";
    }
    if (slot.queued.length >= this.maxQueued) return "rejected";
    slot.queued.push(order);
    return "queued";
  }

  /** The order being executed right now, or null when the entity is idle. */
  current(entityId: number): QueuedOrder | null {
    return this.slots.get(entityId)?.current ?? null;
  }

  /**
   * Promotes the next queued order into the current slot — call when the
   * entity goes idle or finishes its order. Returns the new current order.
   */
  advance(entityId: number): QueuedOrder | null {
    const slot = this.slots.get(entityId);
    if (!slot) return null;
    slot.current = slot.queued.shift() ?? null;
    if (slot.current === null && slot.queued.length === 0) this.slots.delete(entityId);
    return slot.current;
  }

  /** Current order plus everything waiting behind it. */
  size(entityId: number): number {
    const slot = this.slots.get(entityId);
    if (!slot) return 0;
    return (slot.current === null ? 0 : 1) + slot.queued.length;
  }

  /** True when a further order would be rejected for want of room. */
  isFull(entityId: number): boolean {
    const slot = this.slots.get(entityId);
    if (!slot) return false;
    if (slot.current === null) return false;
    return slot.queued.length >= this.maxQueued;
  }

  /** The orders waiting behind the current one, oldest first. */
  pending(entityId: number): QueuedOrder[] {
    const slot = this.slots.get(entityId);
    return slot ? [...slot.queued] : [];
  }

  clear(entityId: number): void {
    this.slots.delete(entityId);
  }

  clearAll(): void {
    this.slots.clear();
  }
}
