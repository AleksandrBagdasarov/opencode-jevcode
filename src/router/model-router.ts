/**
 * Dynamic coding-model selection (story R2, design D3/D5, stage A).
 *
 * Code builds a closed candidate set from `ctx.model.list()` (or the `models` allowlist), Jev answers one
 * `choice` question over the candidate keys plus `keep`, and code maps the answer back to a validated
 * candidate. Anything else (unknown key, low confidence, `keep`, no answer) keeps the current model.
 */
import { parseModelKey, type AllowedModel, type ModelProfile, type Resolved } from "../config.ts";
import { choiceQuestion } from "../jev/questions.ts";
import { pickChoice } from "../jev/response.ts";
import type { Answer, Answers, Question } from "../jev/types.ts";
import type { Logger } from "../log.ts";
import type { ModelRef } from "../state/session-state.ts";
import type { StageAContributor, StageAInput, StageAOutcome, TurnPlan } from "./plan.ts";

/** At most this many candidates are offered to Jev. */
export const MAX_CANDIDATES = 12;
/** Question name used in the batched request. */
export const MODEL_QUESTION = "model";
/** Contributor name; the prompt hook uses it to know whether the model decision survived a failed switch. */
export const MODEL_CONTRIBUTOR = "model";
/** Option meaning "do not switch". Cannot collide with a `provider/id` key. */
export const KEEP = "keep";
/** The raw model list is cached for this long (design: catalogs cached with a short TTL). */
export const CATALOG_TTL_MS = 30_000;
/** Prompt text sent to Jev is cut at this many characters. */
export const PROMPT_STATE_CHARS = 3_000;

export interface ModelCandidate {
  /** `provider/id[#variant]` */
  key: string;
  providerID: string;
  id: string;
  variant?: string;
  name: string;
  /** Context window in tokens (0 = unknown). */
  contextWindow: number;
  /** USD per million tokens; undefined when the host reports no cost. */
  inputPrice?: number;
  outputPrice?: number;
  profile: ModelProfile;
}

const PROFILE_ORDER: readonly ModelProfile[] = ["fast", "balanced", "reasoning", "large-context"];

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** `ctx.model.list()` returns `{ data: ModelInfo[] }`; a bare array is tolerated. */
export function modelsFrom(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const data = isRecord(result) ? result.data : undefined;
  return Array.isArray(data) ? data : [];
}

/**
 * Plugin-defined profile (NOT an OpenCode category), derived from the base (untiered) price and context:
 * - context window >= 400k tokens          -> large-context
 * - output price <= $2 per M (or free)     -> fast
 * - output price >= $15 per M              -> reasoning
 * - otherwise, or no price information     -> balanced
 */
export function deriveProfile(contextWindow: number, outputPrice: number | undefined): ModelProfile {
  if (contextWindow >= 400_000) return "large-context";
  if (outputPrice === undefined) return "balanced";
  if (outputPrice <= 2) return "fast";
  if (outputPrice >= 15) return "reasoning";
  return "balanced";
}

/** The model's base price entry (the one without a context tier), else the first entry. */
function basePrice(cost: unknown): { input?: number; output?: number } {
  if (!Array.isArray(cost)) return {};
  const entries = cost.filter(isRecord);
  const base = entries.find((c) => c.tier === undefined) ?? entries[0];
  return base ? { input: finite(base.input), output: finite(base.output) } : {};
}

/** Enabled, active, chat (an unset type means chat) and tool-capable; with provider and id strings. */
function toCandidate(raw: unknown): ModelCandidate | undefined {
  if (!isRecord(raw)) return undefined;
  const { providerID, id } = raw;
  if (typeof providerID !== "string" || providerID === "" || typeof id !== "string" || id === "") return undefined;
  if (raw.enabled !== true) return undefined;
  if (raw.status !== undefined && raw.status !== "active") return undefined;
  if (raw.type !== undefined && raw.type !== "chat") return undefined;
  const caps = raw.capabilities;
  if (!isRecord(caps) || caps.tools !== true) return undefined;
  const contextWindow = isRecord(raw.limit) ? (finite(raw.limit.context) ?? 0) : 0;
  const price = basePrice(raw.cost);
  return {
    key: `${providerID}/${id}`,
    providerID,
    id,
    name: typeof raw.name === "string" && raw.name !== "" ? raw.name : id,
    contextWindow,
    inputPrice: price.input,
    outputPrice: price.output,
    profile: deriveProfile(contextWindow, price.output),
  };
}

export interface CandidateOptions {
  /** `models` option: when non-empty only these (that are valid in the host catalog), in this order. */
  allowlist?: readonly AllowedModel[];
  max?: number;
  /** Model key kept inside the cap when present (the current session model). */
  pin?: string;
}

/**
 * Closed candidate set. Order is deterministic: allowlist order, or round-robin over profiles
 * (fast, balanced, reasoning, large-context) with the newest release first inside a profile, so a cap
 * never drops a whole class of model.
 */
export function buildCandidates(list: unknown, options: CandidateOptions = {}): ModelCandidate[] {
  const max = Math.max(1, Math.floor(options.max ?? MAX_CANDIDATES));
  const released = new Map<string, number>();
  const valid = new Map<string, ModelCandidate>();
  for (const raw of modelsFrom(list)) {
    const c = toCandidate(raw);
    if (!c || valid.has(c.key)) continue;
    valid.set(c.key, c);
    const time = isRecord(raw) && isRecord(raw.time) ? finite(raw.time.released) : undefined;
    released.set(c.key, time ?? 0);
  }

  let ordered: ModelCandidate[];
  const allow = options.allowlist ?? [];
  if (allow.length > 0) {
    ordered = [];
    for (const entry of allow) {
      const parsed = parseModelKey(entry.model);
      if (!parsed) continue;
      const baseKey = `${parsed.providerID}/${parsed.id}`;
      const c = valid.get(baseKey);
      if (!c) continue;
      const variant = entry.variant ?? parsed.variant;
      const candidateKey = variant ? `${baseKey}#${variant}` : baseKey;
      const candidate: ModelCandidate = {
        ...c,
        key: candidateKey,
        ...(variant ? { variant } : {}),
        profile: entry.profile ?? c.profile,
      };
      ordered.push(candidate);
    }
  } else {
    const byProfile = new Map<ModelProfile, ModelCandidate[]>(PROFILE_ORDER.map((p) => [p, []]));
    for (const c of valid.values()) byProfile.get(c.profile)!.push(c);
    for (const group of byProfile.values()) {
      group.sort((a, b) => (released.get(b.key) ?? 0) - (released.get(a.key) ?? 0) || a.key.localeCompare(b.key));
    }
    ordered = [];
    for (let i = 0; ordered.length < valid.size; i++) {
      for (const p of PROFILE_ORDER) {
        const c = byProfile.get(p)![i];
        if (c) ordered.push(c);
      }
    }
  }

  if (ordered.length <= max) return ordered;
  const parsedPin = options.pin ? parseModelKey(options.pin) : undefined;
  const pinned = options.pin
    ? ordered.find((c) => c.key === options.pin || (parsedPin && c.providerID === parsedPin.providerID && c.id === parsedPin.id && (!parsedPin.variant || c.variant === parsedPin.variant)))
    : undefined;
  const head = ordered.filter((c) => c !== pinned).slice(0, pinned ? max - 1 : max);
  return pinned ? [...head, pinned] : head;
}

const formatContext = (tokens: number): string =>
  tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);

const formatPrice = (n: number): string => `$${+n.toFixed(2)}`;

/** One-line description Jev reads for each option. */
export function describeCandidate(c: ModelCandidate): string {
  const nameWithVariant = c.variant ? `${c.name} (#${c.variant} thinking effort)` : c.name;
  const parts = [`${c.profile} model`, nameWithVariant];
  if (c.contextWindow > 0) parts.push(`${formatContext(c.contextWindow)} context`);
  if (c.inputPrice !== undefined && c.outputPrice !== undefined) {
    parts.push(`${formatPrice(c.inputPrice)} in / ${formatPrice(c.outputPrice)} out per M tokens`);
  }
  return parts.join(", ");
}

const INSTRUCTIONS =
  "Choose the model best suited to execute the coding request in the state. " +
  "Prefer a cheap, fast model for small edits, lookups, questions and simple commands; a reasoning model for " +
  "debugging, design and multi-file changes; a large-context model when the task needs to read a lot of code. " +
  `Answer "${KEEP}" to leave the current model unchanged when unsure.`;

/** The `choice` question: candidate keys + optional `keep` (omitted when no model is active yet). */
export function buildModelQuestion(candidates: readonly ModelCandidate[], hasCurrent = true): Question {
  const options: Record<string, string> = {};
  for (const c of candidates) options[c.key] = describeCandidate(c);
  if (hasCurrent) {
    options[KEEP] = "Keep the current session model (no switch).";
  }
  return choiceQuestion(INSTRUCTIONS, options);
}

export type ModelDecision =
  | { kind: "switch"; candidate: ModelCandidate; confidence: number }
  | { kind: "keep"; reason: string };

/** Map the (untrusted) Jev answer to a validated candidate (design D5). Never throws. */
export function decideModel(
  answer: Answer | undefined,
  candidates: readonly ModelCandidate[],
  minConfidence: number,
): ModelDecision {
  const picked = pickChoice(answer, [...candidates.map((c) => c.key), KEEP], minConfidence);
  if (picked === KEEP) return { kind: "keep", reason: "Jev chose to keep the current model" };
  const candidate = picked === null ? undefined : candidates.find((c) => c.key === picked);
  if (candidate && answer?.kind === "choice") return { kind: "switch", candidate, confidence: answer.confidence };
  return { kind: "keep", reason: explainRejection(answer, candidates) };
}

/** Why `pickChoice` rejected an answer (for the plan's fallbackReason only; never used to apply). */
function explainRejection(answer: Answer | undefined, candidates: readonly ModelCandidate[]): string {
  if (!answer) return "no model answer from Jev";
  if (answer.kind !== "choice") return "model answer had an unexpected kind";
  if (typeof answer.choice !== "string" || (answer.choice !== KEEP && !candidates.some((c) => c.key === answer.choice))) {
    return "Jev chose a model outside the candidate set";
  }
  return `model confidence ${typeof answer.confidence === "number" ? answer.confidence.toFixed(2) : "n/a"} below the minimum`;
}

/** Provider + id only: compares base model identity ignoring variants. */
export const sameModelId = (a: Pick<ModelRef, "providerID" | "id"> | undefined, b: Pick<ModelRef, "providerID" | "id"> | undefined): boolean =>
  !!a && !!b && a.providerID === b.providerID && a.id === b.id;

/**
 * Whether the target model differs from the current model.
 * If target specifies a variant, it must match current's variant; if target has no variant,
 * providerID and id equality is sufficient.
 */
export function shouldSwitchModel(
  target: { providerID: string; id: string; variant?: string } | undefined,
  current: ModelRef | undefined,
): boolean {
  if (!target) return false;
  if (!current) return true;
  if (target.providerID !== current.providerID || target.id !== current.id) return true;
  if (target.variant !== undefined && target.variant !== (current.variant ?? "")) return true;
  return false;
}

export interface ModelRouterDeps {
  options: Pick<Resolved, "models" | "modelMinConfidence" | "timeoutMs">;
  log: Pick<Logger, "debug" | "warn">;
  /** `ctx.model.list` */
  listModels: () => Promise<unknown>;
  now?: () => number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Stage-A contributor for the coding model. */
export function createModelRouter(deps: ModelRouterDeps): StageAContributor {
  const now = deps.now ?? Date.now;
  let cache: { at: number; list: unknown } | undefined;

  async function catalog(): Promise<unknown> {
    if (cache && now() - cache.at < CATALOG_TTL_MS) return cache.list;
    const list = await withTimeout(Promise.resolve().then(() => deps.listModels()), deps.options.timeoutMs, "model.list");
    cache = { at: now(), list };
    return list;
  }

  return {
    name: MODEL_CONTRIBUTOR,
    async prepare(input: StageAInput) {
      let list: unknown;
      try {
        list = await catalog();
      } catch (err) {
        deps.log.warn("model router: could not list models:", err);
        return { skip: "model catalog unavailable" };
      }
      const currentKey = input.current
        ? input.current.variant
          ? `${input.current.providerID}/${input.current.id}#${input.current.variant}`
          : `${input.current.providerID}/${input.current.id}`
        : undefined;
      const candidates = buildCandidates(list, { allowlist: deps.options.models, pin: currentKey });
      if (candidates.length === 0) return { skip: "no candidate models" };
      if (currentKey && candidates.length === 1 && candidates[0]!.key === currentKey) {
        return { skip: "current model is the only candidate" };
      }

      return {
        questions: { [MODEL_QUESTION]: buildModelQuestion(candidates, !!input.current) },
        apply(answers: Answers | null, plan: TurnPlan): StageAOutcome {
          if (!answers) return { decided: false, reason: "Jev unavailable" };
          const decision = decideModel(answers[MODEL_QUESTION], candidates, deps.options.modelMinConfidence);
          if (decision.kind === "keep") return { decided: false, reason: decision.reason };
          const { candidate, confidence } = decision;
          plan.model = {
            providerID: candidate.providerID,
            id: candidate.id,
            ...(candidate.variant ? { variant: candidate.variant } : {}),
            confidence,
          };
          return { decided: true };
        },
      };
    },
  };
}

/** Compact state for the batched Jev request (prompt text is cut; no secrets, no transcript). */
export function buildStageAState(input: Pick<StageAInput, "text" | "current">): { request: string; currentModel: string } {
  const current = input.current;
  const currentModel = current
    ? current.variant && current.variant !== "default"
      ? `${current.providerID}/${current.id}#${current.variant}`
      : `${current.providerID}/${current.id}`
    : "none";
  return {
    request: input.text.length > PROMPT_STATE_CHARS ? `${input.text.slice(0, PROMPT_STATE_CHARS)}…` : input.text,
    currentModel,
  };
}
