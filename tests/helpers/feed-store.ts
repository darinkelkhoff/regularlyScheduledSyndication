import type { FeedStore } from '../../src/publishing/local-publisher.ts';
export class MemoryFeedStore implements FeedStore {
  values = new Map<string, string>();
  async put(key: string, value: string) { this.values.set(key, value); }
  async get(key: string) { const value = this.values.get(key); return value === undefined ? null : { async text() { return value; } }; }
  async delete(key: string) { this.values.delete(key); }
}
