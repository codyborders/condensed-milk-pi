/**
 * Bounded insertion-ordered collections for session telemetry.
 * Oldest entries are evicted when fixed capacity is reached.
 */

/** Maximum entries retained by historical mask telemetry trackers. */
export const MAX_TRACKER_ENTRIES = 10_000;

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("bounded tracker limit must be a positive safe integer");
  }
}

export class BoundedMap<K, V> extends Map<K, V> {
  private readonly limit: number;

  constructor(limit = MAX_TRACKER_ENTRIES) {
    validateLimit(limit);
    super();
    this.limit = limit;
  }

  override set(key: K, value: V): this {
    if (!this.has(key)) {
      while (this.size >= this.limit) {
        const oldest = this.keys().next();
        if (oldest.done) break;
        super.delete(oldest.value);
      }
    }
    super.set(key, value);
    return this;
  }
}

export class BoundedSet<T> extends Set<T> {
  private readonly limit: number;

  constructor(limit = MAX_TRACKER_ENTRIES) {
    validateLimit(limit);
    super();
    this.limit = limit;
  }

  override add(value: T): this {
    if (!this.has(value)) {
      while (this.size >= this.limit) {
        const oldest = this.values().next();
        if (oldest.done) break;
        super.delete(oldest.value);
      }
    }
    super.add(value);
    return this;
  }
}
