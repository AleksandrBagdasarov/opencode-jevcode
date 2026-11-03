/**
 * Provider-neutral Jev client (design D4/D6, story R7).
 *
 * `ask()` NEVER throws and returns `null` on any failure (timeout, network, 4xx/5xx, invalid JSON,
 * a missing answer, invalid question set, no transport). Callers then use their deterministic fallback.
 *
 * Partial success: when some questions are answered and others come back as `error` (or with a kind
 * that does not match the question), the result contains ONLY the usable answers. Callers must treat
 * an absent key as "unanswered" (fall back for that decision only). If a requested question is not
 * present in the response at all, or every answer is an error, the whole call is a failure -> `null`.
 */

import type { Resolved } from "../config.ts";
import type { Logger } from "../log.ts";
import {
  isRetryable,
  JevTimeoutError,
  MAX_CHOICE_OPTIONS,
  MAX_SCORE_LEVELS,
  type Answers,
  type JevTransport,
  type Questions,
} from "./types.ts";
import { createNativeTransport, type GenerateDecisions } from "./transports/native.ts";
import { createOpenRouterTransport } from "./transports/openrouter.ts";
import { createTypesafeTransport } from "./transports/typesafe.ts";
import type { FetchLike } from "./transports/http.ts";

/** The serialised conversation state sent to Jev is capped at this many characters. */
export const STATE_MAX_CHARS = 12_000;
/** After a resolution that found no transport, re-resolve at most once per this interval. */
export const RERESOLVE_INTERVAL_MS = 60_000;

const TRUNCATION_MARK = "…[truncated]";

export interface JevClientDeps {
  options: Pick<Resolved, "provider" | "apiKey" | "apiKeySource" | "endpoint" | "jevModel" | "timeoutMs">;
  log: Logger;
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** `ctx.model.list`; result is `{data: ModelInfo[]}` or `ModelInfo[]`. */
  listModels?: () => Promise<unknown>;
  /** `ctx.experimental.generate.decisions`. */
  generateDecisions?: GenerateDecisions;
  /** Clock for the re-resolve throttle (tests). */
  now?: () => number;
}

export interface JevClient {
  /** Never throws. `null` = Jev unavailable/failed; see module doc for partial answers. */
  ask(state: unknown, questions: Questions): Promise<Answers | null>;
  /** `transport` is the active transport name, `"none"` when unavailable, `"unresolved"` before first ask. */
  describe(): { transport: string };
}

const noop = () => {};

/** Returns a problem description, or null when the question set is valid. */
export function validateQuestions(questions: unknown): string | null {
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) return "questions must be an object";
  const entries = Object.entries(questions as Record<string, unknown>);
  if (entries.length === 0) return "no questions";
  for (const [name, raw] of entries) {
    const q = raw as { kind?: unknown; instructions?: unknown; options?: unknown; levels?: unknown } | null;
    if (!q || typeof q !== "object") return `question "${name}" is not an object`;
    if (typeof q.instructions !== "string") return `question "${name}" has no instructions`;
    if (q.kind === "noul") continue;
    if (q.kind === "choice") {
      const n = q.options && typeof q.options === "object" && !Array.isArray(q.options) ? Object.keys(q.options).length : -1;
      if (n < 1) return `choice "${name}" needs at least 1 option`;
      if (n > MAX_CHOICE_OPTIONS) return `choice "${name}" has more than ${MAX_CHOICE_OPTIONS} options`;
    } else if (q.kind === "score") {
      const n = Array.isArray(q.levels) ? q.levels.length : -1;
      if (n < 2) return `score "${name}" needs at least 2 levels`;
      if (n > MAX_SCORE_LEVELS) return `score "${name}" has more than ${MAX_SCORE_LEVELS} levels`;
    } else {
      return `question "${name}" has unknown kind`;
    }
  }
  return null;
}

/** State passed to transports: the original value when its JSON fits the cap, else a truncated string. */
export function capState(state: unknown): unknown {
  let text: string;
  try {
    text = typeof state === "string" ? state : (JSON.stringify(state) ?? "null");
  } catch {
    return "[unserialisable state]";
  }
  if (text.length <= STATE_MAX_CHARS) return typeof state === "string" ? state : state === undefined ? null : state;
  return text.slice(0, STATE_MAX_CHARS - TRUNCATION_MARK.length) + TRUNCATION_MARK;
}

/** Keeps usable answers for requested questions; null if one is missing or none is usable. */
function finalize(answers: Answers | undefined, questions: Questions): Answers | null {
  if (!answers || typeof answers !== "object") return null;
  const out: Answers = {};
  for (const [name, q] of Object.entries(questions)) {
    const a = answers[name];
    if (!a) return null; // missing question => failure
    if (a.kind === "error" || a.kind !== q.kind) continue; // unanswered
    out[name] = a;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function describeError(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : "unknown error";
}

function modelList(result: unknown): any[] {
  if (Array.isArray(result)) return result;
  const data = (result as { data?: unknown } | null | undefined)?.data;
  return Array.isArray(data) ? data : [];
}

export function createJevClient(deps: JevClientDeps): JevClient {
  const { options, log } = deps;
  const now = deps.now ?? Date.now;
  const fetchFn: FetchLike = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  log.addSecret?.(options.apiKey);

  let current: { transport: JevTransport | null; at: number } | undefined;
  let inflight: Promise<JevTransport | null> | undefined;
  let noticed = false;

  async function findNative(): Promise<JevTransport | null> {
    if (!deps.listModels || !deps.generateDecisions) return null;
    const models = modelList(await deps.listModels()).filter(
      (m) => m && m.type === "decision" && m.enabled !== false && typeof m.providerID === "string" && typeof m.id === "string",
    );
    if (models.length === 0) return null;
    const pick = models.find((m) => /jev/i.test(`${m.id} ${m.modelID ?? ""}`)) ?? models[0];
    return createNativeTransport({
      generateDecisions: deps.generateDecisions,
      model: { providerID: pick.providerID, id: pick.id },
    });
  }

  function http(kind: "typesafe" | "openrouter"): JevTransport | null {
    if (!options.apiKey) return null;
    const cfg = { apiKey: options.apiKey, endpoint: options.endpoint, model: options.jevModel, fetch: fetchFn };
    return kind === "typesafe" ? createTypesafeTransport(cfg) : createOpenRouterTransport(cfg);
  }

  /**
   * With provider=auto the key's kind comes from where it was found. A key given as the `apiKey` option
   * has no env name, so it is TypeSafe unless it looks like an OpenRouter key (`sk-or-`) or the endpoint
   * option points at openrouter.
   */
  function autoKeyKind(): "typesafe" | "openrouter" {
    if (options.apiKeySource === "OPENROUTER_API_KEY") return "openrouter";
    if (options.apiKeySource === "TYPESAFE_API_KEY") return "typesafe";
    if (options.apiKey?.startsWith("sk-or-") || /openrouter/i.test(options.endpoint ?? "")) return "openrouter";
    return "typesafe";
  }

  async function resolveTransport(): Promise<JevTransport | null> {
    try {
      switch (options.provider) {
        case "none":
          return null;
        case "opencode":
          return await findNative();
        case "typesafe":
          return http("typesafe");
        case "openrouter":
          return http("openrouter");
        default: {
          // auto: native decision model -> typesafe key -> openrouter key -> none
          return (await findNative()) ?? (options.apiKey ? http(autoKeyKind()) : null);
        }
      }
    } catch (e) {
      log.warn("jev transport resolution failed:", describeError(e));
      return null;
    }
  }

  function getTransport(): Promise<JevTransport | null> {
    if (current?.transport) return Promise.resolve(current.transport);
    if (current && now() - current.at < RERESOLVE_INTERVAL_MS) return Promise.resolve(null);
    inflight ??= resolveTransport().then((t) => {
      current = { transport: t, at: now() };
      inflight = undefined;
      if (!t && !noticed) {
        noticed = true;
        log.info(`Jev is not available (provider=${options.provider}); running in fallback mode (default model, all tools, no pruning).`);
      }
      return t;
    });
    return inflight;
  }

  async function ask(state: unknown, questions: Questions): Promise<Answers | null> {
    try {
      const problem = validateQuestions(questions);
      if (problem) {
        log.warn(`jev: invalid question set (${problem}); skipping`);
        return null;
      }
      const payload = capState(state);

      // One deadline shared by transport resolution, the first attempt and the retry.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), options.timeoutMs);
      const timeout = new Promise<never>((_, reject) => {
        ctl.signal.addEventListener("abort", () => reject(new JevTimeoutError()), { once: true });
      });
      timeout.catch(noop);

      try {
        const transport = await Promise.race([getTransport(), timeout]);
        if (!transport) return null;

        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            // `.then` turns a synchronous throw into a rejection; `.catch(noop)` avoids an
            // unhandled rejection when the timeout wins the race.
            const call = Promise.resolve().then(() => transport.ask(payload, questions, { signal: ctl.signal }));
            call.catch(noop);
            const answers = await Promise.race([call, timeout]);
            const result = finalize(answers, questions);
            if (!result) log.warn(`jev(${transport.name}): response had missing or only error answers`);
            return result;
          } catch (e) {
            if (ctl.signal.aborted || e instanceof JevTimeoutError) {
              log.warn(`jev(${transport.name}): timed out after ${options.timeoutMs}ms`);
              return null;
            }
            if (attempt === 0 && isRetryable(e)) {
              log.debug(`jev(${transport.name}): retrying once after`, describeError(e));
              continue;
            }
            log.warn(`jev(${transport.name}): request failed:`, describeError(e));
            return null;
          }
        }
        return null;
      } finally {
        clearTimeout(timer);
        // Cancel any still-running transport work (e.g. a request that lost the race).
        if (!ctl.signal.aborted) ctl.abort();
      }
    } catch (e) {
      try {
        log.warn("jev: unexpected failure:", describeError(e));
      } catch {
        // never throw
      }
      return null;
    }
  }

  return {
    ask,
    describe: () => ({ transport: current ? (current.transport?.name ?? "none") : "unresolved" }),
  };
}
