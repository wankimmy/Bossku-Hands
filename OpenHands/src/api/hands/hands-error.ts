import type { HandsErrorBody } from "./hands-types";

/** A failed Hands call. `code` is the server's `error.code`, when it sent one. */
export class HandsApiError extends Error {
  readonly code: string | null;

  readonly status: number | null;

  readonly field: string | null;

  readonly expected: string | null;

  /** The Linear team key on a `linear_team_not_mapped` conflict. */
  readonly teamKey: string | null;

  /** The session on a `linear_issue_in_progress` conflict. */
  readonly sessionId: string | null;

  constructor(
    message: string,
    details: {
      code?: string | null;
      status?: number | null;
      field?: string | null;
      expected?: string | null;
      teamKey?: string | null;
      sessionId?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "HandsApiError";
    this.code = details.code ?? null;
    this.status = details.status ?? null;
    this.field = details.field ?? null;
    this.expected = details.expected ?? null;
    this.teamKey = details.teamKey ?? null;
    this.sessionId = details.sessionId ?? null;
  }
}

export function handsErrorFromBody(
  status: number | null,
  body: unknown,
  fallbackMessage: string,
): HandsApiError {
  const error = (body as Partial<HandsErrorBody> | null | undefined)?.error;
  if (error && typeof error === "object" && typeof error.code === "string") {
    return new HandsApiError(error.message ?? error.code, {
      code: error.code,
      status,
      field: error.field,
      expected: error.expected,
      teamKey: error.teamKey,
      sessionId: error.sessionId,
    });
  }
  return new HandsApiError(fallbackMessage, { status });
}
