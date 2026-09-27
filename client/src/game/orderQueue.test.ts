/**
 * The order queue is what shift-right-click means. Two mistakes are visible
 * immediately: an order becoming "current" while the unit is still walking (so
 * it never executes), and the queue growing past the server's six, which comes
 * back as `queue_full` and silently drops the player's last order.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_QUEUED_ORDERS, OrderQueue, orderCommand } from "./orderQueue";
import type { QueuedOrder } from "./orderQueue";

const A: QueuedOrder = { c: "move", x: 10, z: 10 };
const B: QueuedOrder = { c: "move", x: 20, z: 20 };
const C: QueuedOrder = { c: "move", x: 30, z: 30 };
const ATTACK: QueuedOrder = { c: "attack", target_id: 99 };

describe("OrderQueue", () => {
  let queue: OrderQueue;

  beforeEach(() => {
    queue = new OrderQueue();
  });

  it("makes the first order current because the unit is idle", () => {
    expect(queue.push(1, A)).toBe("current");
    expect(queue.current(1)).toEqual(A);
    expect(queue.pending(1)).toEqual([]);
  });

  it("queues behind the running order instead of replacing it", () => {
    queue.push(1, A);
    expect(queue.push(1, B)).toBe("queued");

    // Replacing the current order would make a unit walking somewhere abandon
    // the trip halfway.
    expect(queue.current(1)).toEqual(A);
    expect(queue.pending(1)).toEqual([B]);
    expect(queue.size(1)).toBe(2);
  });

  it("rejects the seventh queued order, matching the server's queue_full", () => {
    queue.push(1, A);
    for (let i = 0; i < MAX_QUEUED_ORDERS; i++) {
      expect(queue.push(1, { c: "move", x: i + 1, z: i + 1 })).toBe("queued");
    }
    expect(queue.isFull(1)).toBe(true);
    expect(queue.push(1, B)).toBe("rejected");
    expect(queue.size(1)).toBe(MAX_QUEUED_ORDERS + 1);
  });

  it("promotes queued orders in the order they were given", () => {
    queue.push(1, A);
    queue.push(1, B);
    queue.push(1, ATTACK);

    expect(queue.advance(1)).toEqual(B);
    expect(queue.advance(1)).toEqual(ATTACK);
    // FIFO: the attack must not jump ahead of the move before it.
    expect(queue.pending(1)).toEqual([]);
  });

  it("reports idle once the last order has run out", () => {
    queue.push(1, A);
    expect(queue.advance(1)).toBeNull();
    expect(queue.current(1)).toBeNull();
    expect(queue.size(1)).toBe(0);
    // A slot left behind for a unit with no orders is a unit whose next order
    // is queued behind nothing and never runs.
    expect(queue.entityIds).toEqual([]);
  });

  it("keeps queues for different entities apart", () => {
    queue.push(1, A);
    queue.push(2, B);
    queue.push(2, C);

    expect(queue.entityIds).toEqual([1, 2]);
    expect(queue.advance(2)).toEqual(C);
    expect(queue.current(1)).toEqual(A);
  });

  it("clears one entity without disturbing the others", () => {
    queue.push(1, A);
    queue.push(2, B);
    queue.clear(1);

    expect(queue.current(1)).toBeNull();
    expect(queue.current(2)).toEqual(B);
    expect(queue.entityIds).toEqual([2]);
  });

  it("clears everything", () => {
    queue.push(1, A);
    queue.push(2, B);
    queue.clearAll();

    expect(queue.entityIds).toEqual([]);
  });

  it("reports a full queue only once something is actually running", () => {
    // An entity that has never been given an order has nothing to be full of.
    expect(queue.isFull(1)).toBe(false);
    queue.advance(1);
    expect(queue.isFull(1)).toBe(false);
  });

  it("accepts a fresh order again after the queue drains", () => {
    queue.push(1, A);
    queue.advance(1);
    expect(queue.push(1, B)).toBe("current");
    expect(queue.current(1)).toEqual(B);
  });

  it("honours a smaller queue bound", () => {
    const small = new OrderQueue(1);
    small.push(1, A);
    expect(small.push(1, B)).toBe("queued");
    expect(small.push(1, C)).toBe("rejected");
  });

  it("folds the entity id back into the wire command", () => {
    expect(orderCommand(7, A)).toEqual({ c: "move", ids: [7], x: 10, z: 10, queue: false });
    expect(orderCommand(7, A, true)).toEqual({ c: "move", ids: [7], x: 10, z: 10, queue: true });
    expect(orderCommand(7, ATTACK)).toEqual({ c: "attack", ids: [7], target_id: 99, queue: false });
  });

  it("routes a queued order at the right entity on the wire", () => {
    // A production order has to name the building, not a unit id, or the
    // server rejects it.
    expect(orderCommand(4, { c: "train", unit_type: "marine" })).toEqual({
      c: "train",
      building_id: 4,
      unit_type: "marine",
      count: 1,
    });
    expect(orderCommand(4, { c: "harvest" })).toEqual({ c: "harvest", worker_id: 4 });
  });
});
