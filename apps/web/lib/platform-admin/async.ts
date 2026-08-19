export async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => PromiseLike<U> | U,
): Promise<U[]> {
  if (items.length === 0) return [];

  const results: U[] = new Array(items.length);
  let nextIndex = 0;
  const requestedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const workerCount = Math.max(1, Math.min(requestedConcurrency, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
