/**
 * The reference-counted geometry cache.
 *
 * This is the one piece of the geometry layer whose bugs are invisible in
 * play: a leaked entry keeps a GPU buffer alive for the rest of the session,
 * and an over-eager dispose pulls the vertex buffer out from under meshes that
 * are still on screen. So these tests go after the lifecycle directly —
 * identity of the handed-out instance, the exact moment `dispose()` fires, and
 * the accounting the views read to decide what to build.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { GAME, entityDef } from "@shared/gameData";
import {
  GeometryCache,
  clearGeometryCache,
  disposeAll,
  geometryCache,
  releaseGeometry,
  releaseGeometryKey,
} from "./geometryCache";
import { buildAnyGeometry } from "./unitGeometry";

/** Counts builds and records which geometries were disposed. */
function probeBuilder(): { build: (key: string) => THREE.BufferGeometry; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    build: (key: string) => {
      calls.push(key);
      return buildAnyGeometry(key);
    },
  };
}


beforeEach(() => {
  clearGeometryCache();
});

describe("acquire", () => {
  it("builds once and hands back the same instance to every holder", () => {
    const cache = new GeometryCache();
    const { build, calls } = probeBuilder();
    const a = cache.acquire("marine", build);
    const b = cache.acquire("marine", build);
    const c = cache.acquire("marine", build);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(calls).toEqual(["marine"]);
  });

  it("counts one reference per acquire", () => {
    const cache = new GeometryCache();
    const { build } = probeBuilder();
    cache.acquire("marine", build);
    cache.acquire("marine", build);
    cache.acquire("marine", build);
    expect(cache.refCount("marine")).toBe(3);
    expect(cache.stats()).toEqual({ entries: 1, references: 3 });
  });

  it("keeps different keys apart even though they share a builder", () => {
    const cache = new GeometryCache();
    const { build, calls } = probeBuilder();
    const marine = cache.acquire("marine", build);
    const zealot = cache.acquire("zealot", build);
    expect(zealot).not.toBe(marine);
    expect(cache.keys().sort()).toEqual(["marine", "zealot"]);
    expect(calls).toEqual(["marine", "zealot"]);
  });

  it("classifies a key by the roster, so a building key is a building", () => {
    const cache = new GeometryCache();
    const { build } = probeBuilder();
    cache.acquire("bunker", build);
    // The kind is derived from entityDef, so the same key always classifies.
    expect(entityDef("bunker").kind).toBe("building");
    expect(cache.has("bunker")).toBe(true);
  });

  it("rejects a key that is not in the roster rather than caching a hole", () => {
    const cache = new GeometryCache();
    const { build } = probeBuilder();
    expect(() => cache.acquire("not_a_unit", build)).toThrow(/unknown entity type/);
    expect(cache.stats().entries).toBe(0);
  });
});

describe("release", () => {
  it("keeps the buffer alive until the last holder lets go", () => {
    const cache = new GeometryCache();
    const { build } = probeBuilder();
    const g = cache.acquire("marine", build);
    cache.acquire("marine", build);
    const dispose = vi.spyOn(g, "dispose");
    expect(cache.release("marine")).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    expect(cache.has("marine")).toBe(true);
    expect(cache.release("marine")).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(cache.has("marine")).toBe(false);
  });

  it("reports nothing to release for a key it never held", () => {
    const cache = new GeometryCache();
    expect(cache.release("marine")).toBe(false);
    expect(cache.release("not_a_unit")).toBe(false);
  });

  it("drops the entry so the next acquire builds a fresh buffer", () => {
    const cache = new GeometryCache();
    const { build, calls } = probeBuilder();
    const first = cache.acquire("marine", build);
    cache.release("marine");
    const second = cache.acquire("marine", build);
    expect(second).not.toBe(first);
    expect(calls).toEqual(["marine", "marine"]);
  });

  it("releases by geometry for callers that only hold the mesh", () => {
    const cache = new GeometryCache();
    const { build } = probeBuilder();
    const g = cache.acquire("marine", build);
    cache.acquire("marine", build);
    const dispose = vi.spyOn(g, "dispose");
    expect(cache.releaseGeometry(g)).toBe(false);
    expect(cache.releaseGeometry(g)).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("ignores a geometry it never handed out", () => {
    const cache = new GeometryCache();
    const foreign = buildAnyGeometry("marine");
    expect(cache.releaseGeometry(foreign)).toBe(false);
    expect(cache.stats().entries).toBe(0);
  });

  it("refuses to go below zero references on a double release", () => {
    const cache = new GeometryCache();
    const { build } = probeBuilder();
    cache.acquire("marine", build);
    expect(cache.release("marine")).toBe(true);
    // A second release must not resurrect a negative refcount, and must not
    // dispose a buffer some other cache still owns.
    expect(cache.release("marine")).toBe(false);
    expect(cache.refCount("marine")).toBe(0);
  });

  it("keeps two keys independent through interleaved acquires and releases", () => {
    const cache = new GeometryCache();
    const { build } = probeBuilder();
    const marine = cache.acquire("marine", build);
    cache.acquire("bunker", build);
    cache.acquire("bunker", build);
    const marineDispose = vi.spyOn(marine, "dispose");
    expect(cache.release("bunker")).toBe(false);
    expect(cache.release("bunker")).toBe(true);
    expect(marineDispose).not.toHaveBeenCalled();
    expect(cache.keys()).toEqual(["marine"]);
    expect(cache.stats()).toEqual({ entries: 1, references: 1 });
  });
});

describe("accounting", () => {
  it("agrees with what was actually acquired", () => {
    const cache = new GeometryCache();
    const { build } = probeBuilder();
    cache.acquire("marine", build);
    cache.acquire("marine", build);
    cache.acquire("zealot", build);
    expect(cache.has("marine")).toBe(true);
    expect(cache.has("zealot")).toBe(true);
    expect(cache.has("bunker")).toBe(false);
    expect(cache.refCount("bunker")).toBe(0);
    expect(cache.stats()).toEqual({ entries: 2, references: 3 });
    expect(cache.keys().sort()).toEqual(["marine", "zealot"]);
  });

  it("counts references across every key, not just entries", () => {
    const cache = new GeometryCache();
    const { build } = probeBuilder();
    for (const key of ["marine", "zealot", "zergling"]) {
      cache.acquire(key, build);
      cache.acquire(key, build);
    }
    const stats = cache.stats();
    expect(stats.entries).toBe(3);
    expect(stats.references).toBe(6);
  });
});

describe("disposeAll", () => {
  it("disposes every buffer whatever the refcounts say, then empties itself", () => {
    const cache = new GeometryCache();
    const { build } = probeBuilder();
    const marine = cache.acquire("marine", build);
    const bunker = cache.acquire("bunker", build);
    const marineDispose = vi.spyOn(marine, "dispose");
    const bunkerDispose = vi.spyOn(bunker, "dispose");
    cache.disposeAll();
    expect(marineDispose).toHaveBeenCalledTimes(1);
    expect(bunkerDispose).toHaveBeenCalledTimes(1);
    expect(cache.keys()).toEqual([]);
    expect(cache.stats()).toEqual({ entries: 0, references: 0 });
  });

  it("leaves the cache usable afterwards", () => {
    const cache = new GeometryCache();
    const { build, calls } = probeBuilder();
    cache.acquire("marine", build);
    cache.disposeAll();
    const g = cache.acquire("marine", build);
    expect(calls).toEqual(["marine", "marine"]);
    expect(g.getAttribute("position").count).toBeGreaterThan(0);
    expect(cache.refCount("marine")).toBe(1);
    cache.release("marine");
  });
});

describe("module-level cache and helpers", () => {
  it("is the same process-wide instance the entity views use", () => {
    expect(geometryCache).toBeInstanceOf(GeometryCache);
    geometryCache.acquire("marine", buildAnyGeometry);
    expect(geometryCache.has("marine")).toBe(true);
  });

  it("releaseGeometryKey and releaseGeometry act on the shared cache", () => {
    const g = geometryCache.acquire("marine", buildAnyGeometry);
    expect(releaseGeometryKey("marine")).toBe(true);
    const again = geometryCache.acquire("marine", buildAnyGeometry);
    expect(again).not.toBe(g);
    expect(releaseGeometry(again)).toBe(true);
    expect(releaseGeometryKey("not_a_unit")).toBe(false);
  });

  it("clearGeometryCache and its disposeAll alias do the same thing", () => {
    geometryCache.acquire("marine", buildAnyGeometry);
    geometryCache.acquire("bunker", buildAnyGeometry);
    clearGeometryCache();
    expect(geometryCache.stats()).toEqual({ entries: 0, references: 0 });
    geometryCache.acquire("zealot", buildAnyGeometry);
    disposeAll();
    expect(geometryCache.keys()).toEqual([]);
  });

  it("fires a real dispose event on the last release", () => {
    const cache = new GeometryCache();
    const { build } = probeBuilder();
    const g = cache.acquire("marine", build);
    const seen: string[] = [];
    g.addEventListener("dispose", () => seen.push("dispose"));
    cache.acquire("marine", build);
    cache.release("marine");
    cache.release("marine");
    expect(seen).toEqual(["dispose"]);
  });

  it("never disposes a geometry while a roster-wide batch of holders is live", () => {
    // The real scenario: every entity type acquired once at scene build.
    const keys = Object.keys(GAME.units);
    const held = keys.map((key) => geometryCache.acquire(key, buildAnyGeometry));
    expect(geometryCache.stats().entries).toBe(keys.length);
    // Release every other holder, then the last one for a single key.
    for (const key of keys.slice(0, keys.length - 1)) geometryCache.release(key);
    const lastKey = keys[keys.length - 1];
    expect(geometryCache.refCount(lastKey)).toBe(1);
    const dispose = vi.spyOn(held[held.length - 1] as THREE.BufferGeometry, "dispose");
    expect(geometryCache.release(lastKey)).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(geometryCache.keys()).toEqual([]);
  });
});
