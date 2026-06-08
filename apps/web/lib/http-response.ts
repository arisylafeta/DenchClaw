export type JsonByStatusResult<TSuccess, TError> =
  | { ok: true; data: TSuccess }
  | { ok: false; data: TError };

export async function readJsonByStatus<TSuccess, TError>(
  response: Response,
  errorFallback: TError,
): Promise<JsonByStatusResult<TSuccess, TError>> {
  if (response.ok) {
    return {
      ok: true,
      data: (await response.json()) as TSuccess,
    };
  }

  return {
    ok: false,
    data: (await response.json().catch(() => errorFallback)) as TError,
  };
}
