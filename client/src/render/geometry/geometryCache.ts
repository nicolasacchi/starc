/**
 * Shared geometry cache.
 *
 * A hundred Marines are one BufferGeometry and one InstancedMesh, not a
 * hundred copies: every entity type is built once, keyed by its roster
 * `typeKey`, and handed out to whoever needs it. Entries are reference
 * counted, so a geometry is only disposed when its last user releases it —
 * releasing one Marine's handle can never pull the buffer out from under the
 * other ninety-nine.
 *
 * 100% procedural: the cache only ever holds geometry produced by
 * `unitGeometry` / `buildingGeometry` in this same slice.
 */
import * as THREE from "three";
import { entityDef } from "@shared/gameData";

/** Builds a fresh geometry for a roster key the first time it is needed. */
export type GeometryBuilder = (typeKey: string) => THREE.BufferGeometry;

export type GeometryKind = "unit" | "building";

interface CacheEntry {
  key: string;
  kind: GeometryKind;
  geometry: THREE.BufferGeometry;
  refs: number;
}

export interface CacheStats {
  entries: number;
  references: number;
}

export class GeometryCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly owners = new WeakMap<THREE.BufferGeometry, CacheEntry>();

  /**
   * Returns the shared geometry for `key`, building it on first use and
   * taking one reference. The caller owns that reference and must pass the
   * geometry (or its key) to `release` when it is done with it.
   */
  acquire(key: string, build: GeometryBuilder): THREE.BufferGeometry {
    const existing = this.entries.get(key);
    if (existing) {
      existing.refs += 1;
      return existing.geometry;
    }
    // The roster decides what a key is, so one namespace covers all 57 types.
    const kind: GeometryKind = entityDef(key).kind === "building" ? "building" : "unit";
    const geometry = build(key);
    const entry: CacheEntry = { key, kind, geometry, refs: 1 };
    this.entries.set(key, entry);
    this.owners.set(geometry, entry);
    return geometry;
  }

  /** Drops one reference; the geometry is disposed when the last one goes. */
  release(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    entry.refs -= 1;
    if (entry.refs > 0) return false;
    this.entries.delete(entry.key);
    entry.geometry.dispose();
    return true;
  }

  /** Same as `release`, for callers that only hold the geometry itself. */
  releaseGeometry(geometry: THREE.BufferGeometry): boolean {
    const entry = this.owners.get(geometry);
    if (!entry) return false;
    return this.release(entry.key);
  }

  /** True while the geometry is still alive (referenced or not). */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  refCount(key: string): number {
    return this.entries.get(key)?.refs ?? 0;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  stats(): CacheStats {
    let references = 0;
    for (const entry of this.entries.values()) references += entry.refs;
    return { entries: this.entries.size, references };
  }

  /**
   * Forgets every entry and disposes its geometry, whatever the refcounts
   * say. Use on teardown (match over, hot reload); use `release` for normal
   * lifetime so live meshes are never yanked away.
   */
  disposeAll(): void {
    for (const entry of this.entries.values()) entry.geometry.dispose();
    this.entries.clear();
  }
}

/** Process-wide cache used by the entity views. */
export const geometryCache = new GeometryCache();

/** Releases a reference taken by `acquire`. True when it disposed the buffer. */
export function releaseGeometryKey(key: string): boolean {
  return geometryCache.release(key);
}

/** Releases a reference by geometry, for callers that only hold the mesh. */
export function releaseGeometry(geometry: THREE.BufferGeometry): boolean {
  return geometryCache.releaseGeometry(geometry);
}

/** Frees every cached geometry; the cache is usable again afterwards. */
export function clearGeometryCache(): void {
  geometryCache.disposeAll();
}

/** Alias of `clearGeometryCache`, named for the GPU-resource habit it follows. */
export function disposeAll(): void {
  geometryCache.disposeAll();
}
