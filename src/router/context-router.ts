/**
 * Context relevance selection (story R5, design section 5 "Stage B" steps 3-5): a `ContextStage` for the context hook.
 *
 * First model call of a jevCode turn whose conversation has at least `pruneMinTokens` estimated tokens:
 *   1. group the messages into units, mark the FORCED ones (system, latest user message and everything after it, last
 *      `keepRecentMessages`, compaction parts, first user message) - forced units are never asked about;
 *   2. ONE Jev request: a `score` question (0-4) per remaining unit (older ones merged so there are <= 60 questions)
 *      with a compact distilled state; Jev only scores, it writes nothing;
 *   3. code keeps units scoring >= `CONTEXT_KEEP_MIN_SCORE` (an unanswered or low-confidence unit is kept), drops the
 *      lowest scores first while over `min(plan.maxTokens, model context * 0.6)`;
 *   4. the drop set is verified by the post-condition (no new orphan tool parts, forced messages present); if it fails
 *      the original messages are used.
 * The decision is remembered per plan: continuations make no Jev call and just re-apply the same drops (units that did
 * not exist at the first call, e.g. messages appended during the turn, are kept). Only plans with `source: "jev"` are
 * pruned. Every failure leaves the original messages. The stage never throws and never mutates its input beyond
 * assigning `event.messages`.
 */
import type { ContextEvent, ContextStage } from "../opencode/context-hook.ts";
import type { Resolved } from "../config.ts";
import { clip } from "../context/collector.ts";
import { distill, type ContextCandidate } from "../context/distiller.ts";
import { conversationTokens, type MessageUnit } from "../context/message-groups.ts";
import { analyze, applyDrop, type PruneOptions } from "../context/prune.ts";
import { contextBudget, fitToBudget } from "../context/token-budget.ts";
import type { JevClient } from "../jev/client.ts";
import { CONTEXT_QUESTION_PREFIX, contextUnitQuestion } from "../jev/questions.ts";
import { scoreValue } from "../jev/response.ts";
import type { Questions } from "../jev/types.ts";
import type { Logger } from "../log.ts";
import type { TurnPlan } from "./plan.ts";

/** Units scoring below this (0-4) are dropped. */
export const CONTEXT_KEEP_MIN_SCORE = 2;
/** Highest score of the scale. */
export const CONTEXT_MAX_SCORE = 4;
/** At most this many questions go into the stage-B request. */
export const CONTEXT_MAX_QUESTIONS = 60;

export interface ContextRouterDeps {
  options: Pick<Resolved, "keepRecentMessages" | "pruneMinTokens" | "contextMinConfidence" | "keepFirstUser">;
  log: Pick<Logger, "debug" | "warn">;
  client: Pick<JevClient, "ask">;
  /** Context window (tokens) of the request's model, if known. */
  contextWindow?: (model: { providerID: string; id: string }) => Promise<number | undefined>;
  unitMaxTokens?: number;
  maxQuestions?: number;
  maxStateChars?: number;
}

interface Group {
  /** Question suffix and candidate id: the unit id, or `<first id>+<count>` for merged units. */
  id: string;
  units: MessageUnit[];
}

interface Decision {
  dropped: Set<string>;
}

/** Candidate units -> question groups, at most `max`: the newest half stays one-per-unit, older ones are merged. */
export function questionGroups(candidates: readonly MessageUnit[], max: number = CONTEXT_MAX_QUESTIONS): Group[] {
  const limit = Math.max(2, Math.floor(max));
  if (candidates.length <= limit) return candidates.map((u) => ({ id: u.id, units: [u] }));
  const individual = Math.floor(limit / 2);
  const old = candidates.slice(0, candidates.length - individual);
  const merged = limit - individual;
  const size = Math.ceil(old.length / merged);
  const groups: Group[] = [];
  for (let i = 0; i < old.length; i += size) {
    const units = old.slice(i, i + size);
    groups.push(units.length === 1 ? { id: units[0]!.id, units } : { id: `${units[0]!.id}+${units.length}`, units });
  }
  for (const u of candidates.slice(candidates.length - individual)) groups.push({ id: u.id, units: [u] });
  return groups;
}

const candidateOf = (g: Group): ContextCandidate => ({
  id: g.id,
  tokens: g.units.reduce((n, u) => n + u.tokens, 0),
  summary: g.units.length === 1 ? g.units[0]!.summary : clip(`${g.units.length} older units, first: ${g.units[0]!.summary}`, 160),
});

/** Looks the context window up in `ctx.model.list()` (30s cache, timeout guarded, never throws). */
export function createContextWindowLookup(
  listModels: () => Promise<unknown>,
  opts: { ttlMs?: number; timeoutMs?: number; now?: () => number } = {},
): (model: { providerID: string; id: string }) => Promise<number | undefined> {
  const ttl = opts.ttlMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 1500;
  const now = opts.now ?? Date.now;
  let cache: { at: number; windows: Map<string, number> } | undefined;
  return async (model) => {
    try {
      if (!cache || now() - cache.at > ttl) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          listModels(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("model list timed out")), timeoutMs);
          }),
        ]).finally(() => clearTimeout(timer));
        const list = Array.isArray(result) ? result : (result as { data?: unknown } | null)?.data;
        const windows = new Map<string, number>();
        for (const m of Array.isArray(list) ? list : []) {
          const ctxLimit = m?.limit?.context;
          if (typeof m?.providerID === "string" && typeof m?.id === "string" && typeof ctxLimit === "number" && ctxLimit > 0) {
            windows.set(`${m.providerID}/${m.id}`, ctxLimit);
          }
        }
        cache = { at: now(), windows };
      }
      return cache.windows.get(`${model.providerID}/${model.id}`);
    } catch {
      return undefined;
    }
  };
}

const modelRef = (model: unknown): { providerID: string; id: string } | undefined => {
  const m = model as { providerID?: unknown; id?: unknown } | null | undefined;
  return m && typeof m.providerID === "string" && typeof m.id === "string" ? { providerID: m.providerID, id: m.id } : undefined;
};

/** The stage-B context router as a `ContextStage` for `createContextHook({ stages })`. */
export function createContextRouter(deps: ContextRouterDeps): ContextStage {
  const { options, log, client } = deps;
  const prune: PruneOptions = {
    keepRecentMessages: options.keepRecentMessages,
    keepFirstUser: options.keepFirstUser,
    unitMaxTokens: deps.unitMaxTokens,
  };
  /** First-call outcome per plan object (the hook hands out the cached plan object for a whole turn). */
  const decisions = new WeakMap<TurnPlan, Decision>();
  const inflight = new WeakMap<TurnPlan, Promise<Decision>>();

  async function decide(event: ContextEvent, plan: TurnPlan): Promise<Decision> {
    const none: Decision = { dropped: new Set() };
    try {
      const messages = event.messages;
      const analysis = analyze(messages, prune);
      if (!analysis || !Array.isArray(messages)) return none;

      const total = conversationTokens(messages);
      if (total < options.pruneMinTokens) {
        log.debug(`context: ~${total} tokens < pruneMinTokens ${options.pruneMinTokens}; no pruning`);
        return none;
      }
      const candidates = analysis.units.filter((_, k) => !analysis.forced[k]);
      if (candidates.length === 0) return none;

      const groups = questionGroups(candidates, deps.maxQuestions);
      const { state, included } = distill({
        messages,
        candidates: groups.map(candidateOf),
        totalTokens: total,
        maxChars: deps.maxStateChars,
      });
      const askedGroups = groups.filter((g) => included.some((c) => c.id === g.id));
      if (askedGroups.length === 0) return none;
      const questions: Questions = {};
      for (const g of askedGroups) {
        questions[`${CONTEXT_QUESTION_PREFIX}${g.id}`] = contextUnitQuestion({ id: g.id, summary: candidateOf(g).summary });
      }

      const answers = await client.ask(state, questions);
      if (!answers) {
        log.debug("context: Jev unavailable; sending the original messages");
        return none;
      }

      // validate: closed set of asked groups, clamped scores, confidence gate; the rest is "unanswered" and kept
      const score = new Map<string, number>();
      let confidenceSum = 0;
      let usable = 0;
      for (const g of askedGroups) {
        const a = answers[`${CONTEXT_QUESTION_PREFIX}${g.id}`];
        const s = scoreValue(a, CONTEXT_MAX_SCORE);
        const conf = a?.kind === "score" ? a.confidence : Number.NaN;
        if (s === null || typeof conf !== "number" || !(conf >= options.contextMinConfidence)) continue;
        usable++;
        confidenceSum += conf;
        for (const u of g.units) score.set(u.id, s);
      }
      if (usable === 0) {
        log.debug("context: no usable or confident Jev answer; sending the original messages");
        return none;
      }

      let window: number | undefined;
      const ref = modelRef((event as { model?: unknown }).model);
      if (ref && deps.contextWindow) window = await deps.contextWindow(ref).catch(() => undefined);
      const budget = contextBudget(plan.context?.maxTokens, window);

      const fit = fitToBudget(
        analysis.units.map((u, k) => ({
          id: u.id,
          tokens: u.tokens,
          forced: analysis.forced[k]!,
          // an unanswered or low-confidence unit is kept (ranked just above the threshold)
          score: score.get(u.id) ?? CONTEXT_KEEP_MIN_SCORE + 0.5,
        })),
        { budget, minScore: CONTEXT_KEEP_MIN_SCORE },
      );
      if (fit.dropped.length === 0) return none;

      const result = applyDrop(messages, new Set(fit.dropped), prune, analysis);
      if (!result || result.dropped.length === 0) {
        log.warn("context: the pruned request failed the safety check; sending the original messages");
        return none;
      }
      plan.context = {
        keepUnitIds: [...fit.keep],
        droppedUnitIds: result.dropped,
        maxTokens: Number.isFinite(budget) ? budget : 0,
        confidence: confidenceSum / usable,
      };
      log.debug(`context: dropped ${result.dropped.length} unit(s), ~${result.droppedTokens} of ~${total} tokens`);
      return { dropped: new Set(result.dropped) };
    } catch (err) {
      log.warn("context relevance selection failed; sending the original messages:", err);
      return none;
    }
  }

  return {
    name: "context-prune",
    async apply(event, plan) {
      try {
        if (plan.source !== "jev" || !Array.isArray(event.messages)) return;
        let decision = decisions.get(plan);
        if (!decision && plan.context?.droppedUnitIds) decision = { dropped: new Set(plan.context.droppedUnitIds) };
        if (!decision) {
          let pending = inflight.get(plan);
          if (!pending) {
            pending = decide(event, plan).then((d) => {
              decisions.set(plan, d);
              return d;
            });
            inflight.set(plan, pending);
            void pending.finally(() => inflight.delete(plan)).catch(() => {});
          }
          decision = await pending;
        }
        if (decision.dropped.size === 0) return;
        const result = applyDrop(event.messages, decision.dropped, prune);
        if (result && result.dropped.length > 0) event.messages = result.messages;
      } catch (err) {
        log.warn("context pruning failed; sending the original messages:", err);
      }
    },
  };
}
