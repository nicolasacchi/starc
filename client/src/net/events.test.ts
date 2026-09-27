/**
 * The emitter every other netcode module publishes on. Its contract is what
 * lets a caller unsubscribe without the emitter knowing who it is: these tests
 * assert observable delivery, not that a function ran.
 */
import { describe, expect, it, vi } from "vitest";
import { TypedEmitter } from "./events";

interface Events {
  tick: (n: number) => void;
  explode: (why: string) => void;
}

describe("TypedEmitter", () => {
  it("delivers a payload to every listener registered for the type", () => {
    const bus = new TypedEmitter<Events>();
    const seen: string[] = [];
    bus.on("tick", (n) => seen.push(`a${n}`));
    bus.on("tick", (n) => seen.push(`b${n}`));
    bus.on("explode", () => seen.push("wrong-type"));

    bus.emit("tick", 7);

    expect(seen).toEqual(["a7", "b7"]);
  });

  it("stops delivering after the function returned by on() is called", () => {
    const bus = new TypedEmitter<Events>();
    const handler = vi.fn();
    const off = bus.on("tick", handler);

    bus.emit("tick", 1);
    off();
    bus.emit("tick", 2);

    // A stale subscription would double-count a tick somewhere downstream.
    expect(handler.mock.calls).toEqual([[1]]);
  });

  it("tolerates the unsubscribe handle being called twice", () => {
    const bus = new TypedEmitter<Events>();
    const handler = vi.fn();
    const off = bus.on("tick", handler);

    bus.emit("tick", 1);
    off();
    off();
    bus.emit("tick", 3);
    // A second handler proves the emitter did not corrupt its own bookkeeping.
    bus.on("tick", () => undefined);
    bus.emit("tick", 4);

    expect(handler.mock.calls).toEqual([[1]]);
    expect(bus.listenerCount("tick")).toBe(1);
  });

  it("fires a once() listener exactly once across repeated emits", () => {
    const bus = new TypedEmitter<Events>();
    const handler = vi.fn();
    bus.once("tick", handler);

    bus.emit("tick", 1);
    bus.emit("tick", 2);
    bus.emit("tick", 3);

    expect(handler.mock.calls).toEqual([[1]]);
    expect(bus.listenerCount("tick")).toBe(0);
  });

  it("keeps delivering to the remaining listeners when one throws", () => {
    const bus = new TypedEmitter<Events>();
    const after = vi.fn();
    bus.on("explode", () => {
      throw new Error("listener blew up");
    });
    bus.on("explode", after);

    // A single bad subscriber must not be able to starve the renderer of the
    // frames the socket is still pumping.
    expect(() => bus.emit("explode", "test")).not.toThrow();
    expect(after).toHaveBeenCalledWith("test");
  });

  it("keeps delivering when a listener unsubscribes itself mid-emit", () => {
    const bus = new TypedEmitter<Events>();
    const later = vi.fn();
    const off = bus.on("tick", () => off());
    bus.on("tick", later);

    bus.emit("tick", 9);

    expect(later).toHaveBeenCalledWith(9);
  });

  it("off(type) drops every listener of that type and no other", () => {
    const bus = new TypedEmitter<Events>();
    const tick = vi.fn();
    const explode = vi.fn();
    bus.on("tick", tick);
    bus.on("tick", tick);
    bus.on("explode", explode);

    bus.off("tick");

    bus.emit("tick", 1);
    bus.emit("explode", "still here");

    expect(tick).not.toHaveBeenCalled();
    expect(explode).toHaveBeenCalledWith("still here");
  });

  it("emitting an event nobody listens to is a no-op", () => {
    const bus = new TypedEmitter<Events>();
    expect(() => bus.emit("tick", 1)).not.toThrow();
    expect(bus.listenerCount()).toBe(0);
  });
});
