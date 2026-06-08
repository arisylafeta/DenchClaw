type ErrorResponse = {
  error?: string;
};

function readError(data: unknown): string | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const error = (data as ErrorResponse).error;
  return typeof error === "string" && error.length > 0 ? error : undefined;
}

async function readResponseBody(res: Response): Promise<unknown> {
  if (typeof res.json === "function") {
    try {
      return (await res.json()) as unknown;
    } catch {
      if (!res.ok) {
        return {};
      }
      throw new Error("Expected a JSON response.");
    }
  }

  if (typeof res.text !== "function") {
    return {};
  }

  const text = await res.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (!res.ok) {
      return { error: text };
    }
    throw new Error("Expected a JSON response.");
  }
}

export async function readOnboardingResponse<T>(res: Response): Promise<T> {
  const data = await readResponseBody(res);
  if (!res.ok) {
    throw new Error(readError(data) ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export async function assertOnboardingResponseOk(res: Response): Promise<void> {
  const data = await readResponseBody(res);
  if (!res.ok) {
    throw new Error(readError(data) ?? `HTTP ${res.status}`);
  }
}
