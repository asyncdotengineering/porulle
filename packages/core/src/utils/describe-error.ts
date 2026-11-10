/**
 * What a log line may say about a caught error: its name, its code (a SQLSTATE, an errno, a provider's code), an HTTP status, and
 * the `at …` frames that locate it, for it and each cause. Never a message or the error object itself: a query error carries the
 * statement's parameters (a customer's name and address, in a failed order insert), and a provider's error can carry a URL or a
 * body.
 */
export type DescribedError = { name: string; code?: string; status?: number; frames?: string[]; cause?: DescribedError };

export function describeError(error: unknown, depth = 0): DescribedError {
  if (!(error instanceof Error)) return { name: error === null ? "null" : typeof error };
  const fields: Record<string, unknown> = { ...error };
  const code = typeof fields.code === "string" || typeof fields.code === "number" ? String(fields.code) : undefined;
  // `status` on a fetch-shaped error, `statusCode` on an API call error.
  const status = typeof fields.status === "number" ? fields.status : typeof fields.statusCode === "number" ? fields.statusCode : undefined;
  const frames = callFrames(error);
  return {
    name: error.name,
    ...(code === undefined ? {} : { code }),
    ...(status === undefined ? {} : { status }),
    ...(frames.length === 0 ? {} : { frames }),
    ...(error.cause === undefined || depth >= 3 ? {} : { cause: describeError(error.cause, depth + 1) }),
  };
}

/**
 * The `at …` lines of a V8 stack, after its header. The header is `name: message`, and a message can span lines (a provider's
 * body), one of which may itself begin `at `: so the whole header is cut off first, and a stack that does not begin with it (a
 * renamed or rewritten error, another engine's format) gives no frames at all rather than a guess.
 */
function callFrames(error: Error): string[] {
  const stack = error.stack ?? "";
  const header = error.message === "" ? error.name : `${error.name}: ${error.message}`;
  if (!stack.startsWith(header)) return [];
  return stack.slice(header.length).split("\n").map((line) => line.trim()).filter((line) => line.startsWith("at ")).slice(0, 8);
}
