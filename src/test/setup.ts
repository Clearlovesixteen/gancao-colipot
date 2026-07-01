import 'fake-indexeddb/auto';
import { beforeEach } from 'vitest';

const storageState = new Map<string, unknown>();

Object.defineProperty(globalThis, 'chrome', {
  value: {
    storage: {
      local: {
        async get(keys?: string | string[] | Record<string, unknown>) {
          if (!keys) return Object.fromEntries(storageState);
          if (typeof keys === 'string') return { [keys]: storageState.get(keys) };
          if (Array.isArray(keys)) {
            return keys.reduce((acc, key) => {
              acc[key] = storageState.get(key);
              return acc;
            }, {} as Record<string, unknown>);
          }
          return Object.keys(keys).reduce((acc, key) => {
            acc[key] = storageState.has(key) ? storageState.get(key) : keys[key];
            return acc;
          }, {} as Record<string, unknown>);
        },
        async set(values: Record<string, unknown>) {
          Object.entries(values).forEach(([key, value]) => storageState.set(key, value));
        },
        async remove(keys: string | string[]) {
          (Array.isArray(keys) ? keys : [keys]).forEach((key) => storageState.delete(key));
        },
        async clear() {
          storageState.clear();
        },
      },
    },
    runtime: {
      getURL(path: string) {
        return `chrome-extension://test/${path}`;
      },
    },
  },
  configurable: true,
});

beforeEach(async () => {
  storageState.clear();
});
