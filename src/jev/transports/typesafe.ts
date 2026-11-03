import type { JevTransport } from "../types.ts";
import { parseHttpAnswers, postJson, toHttpQuestions, type FetchLike } from "./http.ts";

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

export interface TypesafeConfig {
  apiKey: string;
  /** Endpoint override (option `endpoint`). */
  endpoint?: string;
  /** Option `jevModel`. */
  model?: string;
  fetch: FetchLike;
}

/** TypeSafe System One: POST {model, state, questions} with a Bearer key (design F10). */
export function createTypesafeTransport(cfg: TypesafeConfig): JevTransport {
  const url = cfg.endpoint || TYPESAFE_ENDPOINT;
  const model = cfg.model || TYPESAFE_DEFAULT_MODEL;
  return {
    name: "typesafe",
    async ask(state, questions, { signal }) {
      const json = await postJson(cfg.fetch, url, cfg.apiKey, { model, state, questions: toHttpQuestions(questions) }, signal);
      return parseHttpAnswers(json);
    },
  };
}
