import type { JevTransport } from "../types.ts";
import { parseHttpAnswers, postJson, toHttpQuestions, type FetchLike } from "./http.ts";

export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const OPENROUTER_DEFAULT_MODEL = "typesafe/jev-1.13";

export interface OpenRouterConfig {
  apiKey: string;
  /** Endpoint override (option `endpoint`). */
  endpoint?: string;
  /** Option `jevModel`. */
  model?: string;
  fetch: FetchLike;
}

/** OpenRouter alpha decisions endpoint: same shapes as TypeSafe; `usage.cost` in the response is ignored. */
export function createOpenRouterTransport(cfg: OpenRouterConfig): JevTransport {
  const url = cfg.endpoint || OPENROUTER_ENDPOINT;
  const model = cfg.model || OPENROUTER_DEFAULT_MODEL;
  return {
    name: "openrouter",
    async ask(state, questions, { signal }) {
      const json = await postJson(cfg.fetch, url, cfg.apiKey, { model, state, questions: toHttpQuestions(questions) }, signal);
      return parseHttpAnswers(json);
    },
  };
}
