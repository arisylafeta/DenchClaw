export const PLATFORM_FILTER_BATCH_SIZE = 100;
const PLATFORM_READ_CONCURRENCY = 4;

type ReadResult<T> = {
  data: T[] | null;
  error: { message: string } | null;
};

export async function readRowsInBatches<T>(
  values: string[],
  loadBatch: (values: string[]) => PromiseLike<ReadResult<T>>,
): Promise<T[]> {
  const uniqueValues = [...new Set(values.filter(Boolean))];
  if (uniqueValues.length === 0) return [];

  const batches: string[][] = [];
  for (let index = 0; index < uniqueValues.length; index += PLATFORM_FILTER_BATCH_SIZE) {
    batches.push(uniqueValues.slice(index, index + PLATFORM_FILTER_BATCH_SIZE));
  }

  const results = await mapWithConcurrency(
    batches,
    PLATFORM_READ_CONCURRENCY,
    loadBatch,
  );

  return results.flatMap((result) => {
    if (result.error) throw new Error(result.error.message);
    return result.data ?? [];
  });
}

export async function readAllRowsInBatches<T>(
  values: string[],
  loadPage: (values: string[], from: number, to: number) => PromiseLike<ReadResult<T>>,
  options: { pageSize?: number; maxRowsPerBatch?: number } = {},
): Promise<T[]> {
  return readRowsInBatches<T[]>(values, async (batch) => ({
    data: [await readAllRows(
      (from, to) => loadPage(batch, from, to),
      { pageSize: options.pageSize, maxRows: options.maxRowsPerBatch },
    )],
    error: null,
  })).then((pages) => pages.flat());
}

export async function readAllRows<T>(
  loadPage: (from: number, to: number) => PromiseLike<ReadResult<T>>,
  options: { pageSize?: number; maxRows?: number } = {},
): Promise<T[]> {
  const pageSize = options.pageSize ?? 1_000;
  const maxRows = options.maxRows ?? 10_000;
  const rows: T[] = [];

  while (rows.length < maxRows) {
    const from = rows.length;
    const result = await loadPage(from, from + pageSize - 1);
    if (result.error) throw new Error(result.error.message);

    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }

  throw new Error(`Platform read exceeded its ${maxRows.toLocaleString()} row safety limit`);
}
import { mapWithConcurrency } from "./async";
