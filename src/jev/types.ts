/**
 * Provider-neutral question/answer model for Jev (design D4).
 * Transports map these to TypeSafe HTTP, OpenRouter or OpenCode-native `generate.decisions`.
 */

export type Question =
  | { kind: "choice"; instructions: string; options: Record<string, string> }
  | { kind: "noul"; instructions: string }
  | { kind: "score"; instructions: string; levels: string[] };

export type Answer =
  | { kind: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { kind: "noul"; probability: number }
  | { kind: "score"; score: number; confidence: number }
  | { kind: "error"; reason: string };

export type Questions = Record<string, Question>;
export type Answers = Record<string, Answer>;

/** Hard limits of the TypeSafe API (design F10). */
export const MAX_CHOICE_OPTIONS = 255;
export const MAX_SCORE_LEVELS = 10;

export interface JevTransport {
  /** Short stable name used in logs, e.g. "typesafe". */
  name: string;
  /**
   * Ask Jev. May throw/reject: the client catches everything and fails open.
   * Missing questions in the result are treated as a failure by the client.
   */
  ask(state: unknown, questions: Questions, opts: { signal: AbortSignal }): Promise<Answers>;
}

/** Transport-level failures. Messages must never contain credentials. */
export class JevHttpError extends Error {
  constructor(readonly status: number) {
    super(`Jev HTTP ${status}`);
    this.name = "JevHttpError";
  }
}

/** Network-level failure (fetch rejected, native call rejected). Retryable. */
export class JevNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevNetworkError";
  }
}

/** Unusable response (invalid JSON, wrong shape). Not retried. */
export class JevProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevProtocolError";
  }
}

export class JevTimeoutError extends Error {
  constructor() {
    super("Jev request timed out");
    this.name = "JevTimeoutError";
  }
}

/** Retry policy: network errors and HTTP 5xx only (never 4xx, timeouts or protocol errors). */
export function isRetryable(err: unknown): boolean {
  if (err instanceof JevNetworkError) return true;
  if (err instanceof JevHttpError) return err.status >= 500 && err.status <= 599;
  return false;
}
