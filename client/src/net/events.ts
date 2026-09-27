/**
 * A tiny strongly-typed event emitter. No Node `EventEmitter`, no dependency —
 * the whole netcode slice runs in the browser and under Vitest's `node`
 * environment, and this is the only pub/sub primitive the rest of the slice is
 * allowed to use.
 *
 * Type safety comes from a map interface:
 *
 * ```ts
 * interface Events { tick: number; explode: string }
 * const bus = new TypedEmitter<Events>();
 * const off = bus.on("tick", (n: number) => { console.log(n); });
 * ```
 *
 * Every `on` returns an unsubscribe function; `once` self-unsubscribes after
 * the first delivery. Handler storage is per type and is only ever as large as
 * the callers that registered, so a long session never grows the emitter.
 */

export type EventHandler<TPayload> = (payload: TPayload) => void;

/**
 * Map of event name → payload type. Any object with matching key and payload
 * types qualifies; an index signature is deliberately not required, so a plain
 * `interface` works as a map.
 */
export type EventMap = object;

/**
 * Surfaces a listener that threw without letting it escape `emit`. The socket
 * message pump calls `emit`, so an uncaught throw there would tear down the
 * whole connection and every other listener with it.
 */
function reportHandlerError(type: string, err: unknown): void {
  if (typeof console !== "undefined" && typeof console.error === "function") {
    console.error(`[starc] listener for "${type}" threw`, err);
  }
}



/** Returned by `on`/`once`; safe to call more than once. */
export type Unsubscribe = () => void;

/** Minimal storage type — a `Set` per event name, erased to `never`. */
type HandlerSet<M extends EventMap> = Map<keyof M, Set<EventHandler<never>>>;

export class TypedEmitter<M extends EventMap> {
  private readonly handlers: HandlerSet<M> = new Map();
  /** Registers `handler` for `type`; the returned function removes it. */
  on<K extends keyof M & string>(type: K, handler: EventHandler<M[K]>): Unsubscribe {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const erased = handler as EventHandler<never>;
    set.add(erased);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const live = this.handlers.get(type);
      if (!live) return;
      live.delete(erased);
      if (live.size === 0) this.handlers.delete(type);
    };
  }

  /** Registers a handler that is removed immediately after its first call. */
  once<K extends keyof M & string>(type: K, handler: EventHandler<M[K]>): Unsubscribe {
    const off = this.on(type, ((payload: M[K]) => {
      off();
      handler(payload);
    }) as EventHandler<M[K]>);
    return off;
  }

  /** Removes one handler, or every handler of `type` when `handler` is omitted. */
  off<K extends keyof M & string>(type: K, handler?: EventHandler<M[K]>): void {
    if (!handler) {
      this.handlers.delete(type);
      return;
    }
    const live = this.handlers.get(type);
    if (!live) return;
    live.delete(handler as EventHandler<never>);
    if (live.size === 0) this.handlers.delete(type);
  }

  /**
   * Delivers `payload` to every handler of `type`. Iteration happens over the
   * live `Set`, so a handler may unsubscribe itself (or a sibling) mid-emit
   * without disturbing the current delivery.
   */
  emit<K extends keyof M & string>(type: K, payload: M[K]): void {
    const set = this.handlers.get(type);
    if (!set || set.size === 0) return;
    for (const handler of set) {
      // One throwing listener must not abort delivery to the rest, nor
      // rethrow out of the socket's message pump and take down the connection.
      try {
        (handler as EventHandler<M[K]>)(payload);
      } catch (err) {
        reportHandlerError(type, err);
      }
    }
  }

  /** Number of registered handlers, for one type or all types. */
  listenerCount(type?: keyof M & string): number {
    if (type !== undefined) return this.handlers.get(type)?.size ?? 0;
    let total = 0;
    for (const set of this.handlers.values()) total += set.size;
    return total;
  }

  /** Drops every handler of one type, or the whole emitter. */
  removeAll(type?: keyof M & string): void {
    if (type !== undefined) this.handlers.delete(type);
    else this.handlers.clear();
  }
}
