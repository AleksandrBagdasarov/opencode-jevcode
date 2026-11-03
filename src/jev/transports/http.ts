/**
 * Shared pieces of the two HTTP transports (TypeSafe System One and the OpenRouter alpha decisions
 * endpoint). Both use the same question shape and the same answer shape (design F10).
 */

import {
  JevHttpError,
  JevNetworkError,
  JevProtocolError,
  type Answer,
  type Answers,
  type Questions,
} from "../types.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type HttpQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] };

export function toHttpQuestions(questions: Questions): Record<string, HttpQuestion> {
  const out: Record<string, HttpQuestion> = {};
  for (const [name, q] of Object.entries(questions)) {
    if (q.kind === "choice") out[name] = { type: "choice", instructions: q.instructions, criteria: { ...q.options } };
    else if (q.kind === "noul") out[name] = { type: "noul", instructions: q.instructions };
    else out[name] = { type: "score", instructions: q.instructions, criteria: [...q.levels] };
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Parses `{answers: {name: {type, ...}}}`. Unknown/garbled entries become `error` answers. */
export function parseHttpAnswers(json: unknown): Answers {
  if (!isRecord(json) || !isRecord(json.answers)) throw new JevProtocolError("response has no answers object");
  const out: Answers = {};
  for (const [name, raw] of Object.entries(json.answers)) out[name] = parseOne(raw);
  return out;
}

function parseOne(raw: unknown): Answer {
  if (!isRecord(raw)) return { kind: "error", reason: "malformed answer" };
  switch (raw.type) {
    case "noul":
      return isNum(raw.noul) ? { kind: "noul", probability: raw.noul } : { kind: "error", reason: "malformed noul answer" };
    case "choice": {
      if (typeof raw.choice !== "string" || !isNum(raw.confidence)) return { kind: "error", reason: "malformed choice answer" };
      const probabilities: Record<string, number> = {};
      if (isRecord(raw.probabilities)) {
        for (const [k, v] of Object.entries(raw.probabilities)) if (isNum(v)) probabilities[k] = v;
      }
      return { kind: "choice", choice: raw.choice, confidence: raw.confidence, probabilities };
    }
    case "score":
      return isNum(raw.score) && isNum(raw.confidence)
        ? { kind: "score", score: raw.score, confidence: raw.confidence }
        : { kind: "error", reason: "malformed score answer" };
    case "error":
      return { kind: "error", reason: typeof raw.reason === "string" ? raw.reason : "error" };
    default:
      return { kind: "error", reason: "unknown answer type" };
  }
}

/**
 * POSTs JSON with a Bearer key and returns the parsed body.
 * Throws JevNetworkError (fetch rejected), JevHttpError (non-2xx) or JevProtocolError (bad JSON).
 * Messages never contain the key, the request body or the response body.
 */
export async function postJson(
  fetchFn: FetchLike,
  url: string,
  apiKey: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    // Aborts are reported as-is so the client can classify them as timeouts.
    if (signal.aborted) throw e;
    throw new JevNetworkError(`Jev network error: ${e instanceof Error ? e.name : "unknown"}`);
  }
  if (!res.ok) throw new JevHttpError(res.status);
  try {
    return await res.json();
  } catch {
    if (signal.aborted) throw new JevProtocolError("aborted while reading response");
    throw new JevProtocolError("response is not valid JSON");
  }
}
