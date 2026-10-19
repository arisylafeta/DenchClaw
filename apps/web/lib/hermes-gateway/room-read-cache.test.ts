import { afterEach, it, expect, vi } from 'vitest';
import { BoundedReads } from './room-read-cache';
afterEach(() => vi.useRealTimers());
it('bounds completed entries and evicts by TTL without another request', async () => {
  vi.useFakeTimers(); const cache = new BoundedReads<number>(2, 5000);
  const work = vi.fn(async () => 1);
  await cache.read('a', work); await cache.read('b', work); await cache.read('c', work);
  await cache.read('a', work); expect(work).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(5000);
  await cache.read('a', work); expect(work).toHaveBeenCalledTimes(5);
});
it('evicts completed payloads by approximate total bytes', async () => {
  const cache = new BoundedReads<string>(10, 5000, 40);
  const work = vi.fn(async () => '0123456789');
  await cache.read('a', work); await cache.read('b', work);
  await cache.read('a', work); expect(work).toHaveBeenCalledTimes(3);
});
it('preserves in-flight coalescing even when admission is full', async () => {
  const cache = new BoundedReads<number>(1, 5000);
  let resolve!: (n: number) => void;
  const first = cache.read('a', () => new Promise<number>(r => { resolve = r; }));
  const work = vi.fn(async () => 2);
  const second = cache.read('b', work); const duplicate = cache.read('b', work);
  await Promise.resolve(); expect(work).not.toHaveBeenCalled();
  resolve(1); await Promise.all([first, second, duplicate]);
  expect(work).toHaveBeenCalledTimes(1);
});
