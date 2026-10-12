/** Bounded process-local cache; concurrent users share one read, errors remain retryable. */
export class ShortReadCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<T> }>();

  constructor(private readonly ttlMs = 10 * 60_000, private readonly limit = 128, private readonly now = Date.now) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    this.entries.delete(key);
    for (const [entryKey, entry] of this.entries) {
      if (entry.expiresAt <= this.now()) this.entries.delete(entryKey);
    }
    while (this.entries.size >= this.limit) this.entries.delete(this.entries.keys().next().value!);
    const entry = { expiresAt: this.now() + this.ttlMs, value: Promise.resolve().then(load) };
    this.entries.set(key, entry);
    void entry.value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.value;
  }

  clear(): void {
    // Pending reads cannot repopulate the map after invalidation.
    this.entries.clear();
  }
}
