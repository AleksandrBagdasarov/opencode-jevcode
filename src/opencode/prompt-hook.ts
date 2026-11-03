/**
 * Stage A of the router: the `prompt` hook (design section 5, story R2/R6).
 *
 * Order of work for each prompt:
 *   1. resolve the session's agent; not jevCode -> run the model RESTORE (R1.5) and return untouched
 *      (zero Jev calls, zero plans);
 *   2. jevCode: drop stale restore memory, read the session model, let every contributor prepare its
 *      questions, send ONE batched Jev request, apply the answers (code validates, design D5);
 *   3. switch the model only when Jev chose a different one, remember {previous, applied};
 *   4. store the TurnPlan for the session (a failure stores a fallback plan).
 *
 * The callback never throws and never waits on Jev longer than `timeoutMs` (the client enforces it).
 * Spike (research.md R-2): `switchModel` inside this hook does not deadlock and applies to the same prompt.
 */
import { isJevAgent, resolveSessionAgent, unwrapSession } from "../agent/isolation.ts";
import type { Resolved } from "../config.ts";
import type { JevClient } from "../jev/client.ts";
import { jevClientFor } from "./jev-client.ts";
import type { Answers, Questions } from "../jev/types.ts";
import type { Logger } from "../log.ts";
import type { Module } from "../modules.ts";
import {
  buildStageAState,
  createModelRouter,
  MODEL_CONTRIBUTOR,
  sameModelId,
} from "../router/model-router.ts";
import { createSkillRouter } from "../router/skill-router.ts";
import { createToolRouter } from "../router/tool-router.ts";
import { fallbackPlan, turnKeyFor, turnPlans, type StageAContributor, type StageAInput, type StageAPrepared, type TurnPlan } from "../router/plan.ts";
import {
  createRestoreMemory,
  planRemember,
  reconcileOnJevPrompt,
  restoreIfNeeded,
  toModelRef,
  type PlanCache,
  type RestoreCtx,
  type RestoreMemory,
  type StorageLike,
} from "../state/session-state.ts";

/** The part of the `prompt` hook event used here. */
export interface PromptEvent {
  sessionID: string;
  messageID?: string;
  prompt?: { text?: string; skills?: unknown[]; files?: unknown[] };
}

export interface PromptHookDeps {
  ctx: RestoreCtx;
  options: Pick<Resolved, "makeDefault">;
  log: Pick<Logger, "debug" | "info" | "warn">;
  client: Pick<JevClient, "ask">;
  memory: RestoreMemory;
  plans: PlanCache<TurnPlan>;
  /** Stage-A routers in question order. Skill and tool routers are appended by later tickets. */
  contributors: readonly StageAContributor[];
  now?: () => number;
}

type Prepared = StageAPrepared & { name: string };

/** Builds the `prompt` hook callback. The returned function never throws. */
export function createPromptHook(deps: PromptHookDeps): (event: PromptEvent) => Promise<void> {
  const { ctx, options, log, client, memory, plans, contributors } = deps;
  const now = deps.now ?? Date.now;

  async function route(event: PromptEvent, sessionID: string, turnKey: string, text: string): Promise<TurnPlan> {
    const plan = fallbackPlan(sessionID, turnKey, "no routing decision", now());

    let current;
    try {
      current = toModelRef(unwrapSession(await ctx.session.get({ sessionID }))?.model);
    } catch (err) {
      log.warn("could not read the session model:", err);
    }
    if (!current) return { ...plan, fallbackReason: "session model unreadable" };

    const input: StageAInput = { sessionID, turnKey, text, current, prompt: event.prompt ?? {} };
    const reasons: string[] = [];

    // 1. every contributor adds its questions to the same request
    const prepared: Prepared[] = [];
    const questions: Questions = {};
    for (const c of contributors) {
      try {
        const result = await c.prepare(input);
        if ("skip" in result) {
          reasons.push(`${c.name}: ${result.skip}`);
          continue;
        }
        const clash = Object.keys(result.questions).find((name) => name in questions);
        if (clash) {
          log.warn(`router ${c.name}: question name "${clash}" is already taken; contributor skipped`);
          reasons.push(`${c.name}: duplicate question name`);
          continue;
        }
        Object.assign(questions, result.questions);
        prepared.push({ ...result, name: c.name });
      } catch (err) {
        log.warn(`router ${c.name} failed to prepare:`, err);
        reasons.push(`${c.name}: prepare failed`);
      }
    }

    // 2. ONE batched Jev request (none when nobody has a question)
    let answers: Answers | null = null;
    if (Object.keys(questions).length > 0) {
      answers = await client.ask(buildStageAState(input), questions);
      if (!answers) reasons.push("Jev unavailable or timed out");
    }

    // 3. apply: each contributor works on a scratch copy and is merged only when it succeeds
    const decidedBy: string[] = [];
    for (const p of prepared) {
      try {
        const scratch = structuredClone(plan);
        const outcome = await p.apply(answers, scratch);
        if (outcome.decided) {
          Object.assign(plan, scratch);
          decidedBy.push(p.name);
        } else if (outcome.reason && answers) {
          reasons.push(`${p.name}: ${outcome.reason}`);
        }
      } catch (err) {
        log.warn(`router ${p.name} failed to apply its answers:`, err);
        reasons.push(`${p.name}: apply failed`);
      }
    }

    // 4. switch the model only when it differs; remember the way back
    if (plan.model && !sameModelId(plan.model, current)) {
      const target = { providerID: plan.model.providerID, id: plan.model.id };
      try {
        await ctx.session.switchModel({ sessionID, model: target });
        log.info(`model ${current.providerID}/${current.id} -> ${target.providerID}/${target.id} (confidence ${plan.model.confidence.toFixed(2)})`);
        await remember(sessionID, current, target);
      } catch (err) {
        log.warn(`could not switch to ${target.providerID}/${target.id}; keeping the current model:`, err);
        plan.model = undefined;
        reasons.push("model switch failed");
        const i = decidedBy.indexOf(MODEL_CONTRIBUTOR);
        if (i >= 0) decidedBy.splice(i, 1);
      }
    }

    if (decidedBy.length > 0) {
      plan.source = "jev";
      delete plan.fallbackReason;
    } else {
      plan.source = "fallback";
      plan.fallbackReason = reasons.join("; ") || "no routing decision";
    }
    return plan;
  }

  /** `applied` is the model the session reports after the switch (it carries the host's variant). */
  async function remember(sessionID: string, previous: NonNullable<ReturnType<typeof toModelRef>>, target: { providerID: string; id: string }) {
    let applied: NonNullable<ReturnType<typeof toModelRef>> = target;
    try {
      const after = toModelRef(unwrapSession(await ctx.session.get({ sessionID }))?.model);
      if (after && sameModelId(after, target)) applied = after;
    } catch {
      // the chosen model is a good enough record
    }
    const existing = await memory.peek(sessionID);
    await memory.remember(sessionID, planRemember(existing, previous, applied));
  }

  return async function onPrompt(event: PromptEvent): Promise<void> {
    const sessionID = event?.sessionID;
    if (typeof sessionID !== "string" || sessionID === "") return;
    let plan: TurnPlan | undefined;
    let jev = false;
    let turnKey = "";
    try {
      const agent = await resolveSessionAgent(ctx, sessionID, options);
      if (!isJevAgent(agent)) {
        await restoreIfNeeded(ctx, memory, sessionID, log);
        return;
      }
      jev = true;
      const text = typeof event.prompt?.text === "string" ? event.prompt.text : "";
      turnKey = turnKeyFor(event.messageID, text);
      await reconcileOnJevPrompt(ctx, memory, sessionID, log);
      plan = await route(event, sessionID, turnKey, text);
    } catch (err) {
      try {
        log.warn("prompt hook failed; using the fallback plan:", err);
      } catch {
        // never throw
      }
      if (jev) plan = fallbackPlan(sessionID, turnKey, "prompt hook error", now());
    } finally {
      try {
        if (plan) plans.set(plan);
      } catch {
        // never throw
      }
    }
  };
}

/** Structural subset of the host `Context` used by the prompt hook module. */
export interface PromptHookCtx extends RestoreCtx {
  readonly session: RestoreCtx["session"] & {
    hook(name: "prompt", callback: (event: PromptEvent) => Promise<void> | void): Promise<{ dispose(): Promise<void> | void }>;
  };
  readonly model: { list(): Promise<unknown> };
  readonly skill: { list(): Promise<unknown> | unknown };
  readonly storage: StorageLike;
  readonly experimental: { readonly generate: { decisions(input: any, options?: { signal?: AbortSignal }): Promise<unknown> } };
}

/** Wiring entry for MODULES. Returns the hook registration so cleanup unregisters it. */
export const promptHookModule: Module<PromptHookCtx> = {
  name: "prompt-hook",
  async init(ctx, { options, log }) {
    const client = jevClientFor(ctx, options, log);
    const callback = createPromptHook({
      ctx,
      options,
      log,
      client,
      memory: createRestoreMemory(ctx.storage, log),
      plans: turnPlans,
      contributors: [
        createModelRouter({ options, log, listModels: () => ctx.model.list() }),
        createSkillRouter({ options, log, listSkills: () => ctx.skill.list() }),
        createToolRouter({ options, log }),
      ],
    });
    return ctx.session.hook("prompt", callback);
  },
};
