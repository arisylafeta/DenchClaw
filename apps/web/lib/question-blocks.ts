export type QuestionOption = {
  id: string;
  label: string;
  description?: string;
};

export type QuestionBlock = {
  id: string;
  prompt: string;
  allowMultiple: boolean;
  optional: boolean;
  options: QuestionOption[];
  optionalDetailsPlaceholder?: string;
};

export type QuestionBlockSegment =
  | { type: "text"; text: string }
  | { type: "question"; question: QuestionBlock };

const QUESTION_FENCE_PATTERN = /```dench-question[^\n]*\n([\s\S]*?)```/g;

export function splitQuestionBlocks(text: string): QuestionBlockSegment[] {
  const segments: QuestionBlockSegment[] = [];
  let cursor = 0;

  QUESTION_FENCE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(QUESTION_FENCE_PATTERN)) {
    const start = match.index ?? 0;
    const rawBlock = match[0];
    const json = match[1]?.trim() ?? "";

    if (start > cursor) {
      pushTextSegment(segments, text.slice(cursor, start));
    }

    const question = parseQuestionBlock(json);
    if (question) {
      segments.push({ type: "question", question });
    } else {
      pushTextSegment(segments, rawBlock);
    }

    cursor = start + rawBlock.length;
  }

  if (cursor < text.length) {
    pushTextSegment(segments, text.slice(cursor));
  }

  return segments.length > 0 ? segments : [{ type: "text", text }];
}

export function parseQuestionBlock(json: string): QuestionBlock | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  const raw = asRecord(parsed);
  if (!raw) {
    return null;
  }

  const id = readNonEmptyString(raw.id);
  const prompt = readNonEmptyString(raw.prompt);
  if (!id || !prompt || !Array.isArray(raw.options)) {
    return null;
  }

  const options = raw.options
    .map(parseQuestionOption)
    .filter((option): option is QuestionOption => option !== null);

  if (options.length < 2 || hasDuplicateIds(options)) {
    return null;
  }

  const optionalDetailsPlaceholder =
    readNonEmptyString(raw.optionalDetailsPlaceholder) ??
    readNonEmptyString(raw.detailsPlaceholder);

  return {
    id,
    prompt,
    allowMultiple: raw.allowMultiple === true,
    optional: raw.optional === true,
    options,
    ...(optionalDetailsPlaceholder ? { optionalDetailsPlaceholder } : {}),
  };
}

function parseQuestionOption(input: unknown): QuestionOption | null {
  const raw = asRecord(input);
  if (!raw) {
    return null;
  }

  const id = readNonEmptyString(raw.id);
  const label = readNonEmptyString(raw.label);
  if (!id || !label) {
    return null;
  }

  const description = readNonEmptyString(raw.description);
  return {
    id,
    label,
    ...(description ? { description } : {}),
  };
}

function pushTextSegment(segments: QuestionBlockSegment[], text: string) {
  if (!text) {
    return;
  }

  const previous = segments[segments.length - 1];
  if (previous?.type === "text") {
    previous.text += text;
  } else {
    segments.push({ type: "text", text });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function hasDuplicateIds(options: QuestionOption[]): boolean {
  return new Set(options.map((option) => option.id)).size !== options.length;
}
