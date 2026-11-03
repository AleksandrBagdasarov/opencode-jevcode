/**
 * Stage B of the router: the `context` hook (design section 5, story R4.2-R4.4, R6.2-R6.4).
 *
 * Runs before every model call. For any agent other than jevCode it returns at once (no state read, no change, no Jev
 * call). For jevCode it:
 *   1. loads the plan the prompt hook cached for this session and validates its turnKey against the latest user
 *      message; a stale or missing plan means the deterministic fallback (all tools, minimal note);
 *   2. runs the extension stages (message pruning, ticket 0007) - they get the plan and may change `event.messages`;
 *   3. deletes the tools of excluded groups from `event.tools` (never always-keep tools, tools referenced by messages
 *      still in the request, ungrouped tools; and nothing at all if that would empty the tool set);
 *   4. appends a short routing note as a NEW part of `event.system`.
 *
 * It never calls Jev: continuations of a turn (same turnKey) just re-apply the cached plan. It never throws.
 * Removing a tool from a request is request shaping only; nothing here reads or changes the host's access rules.
 */
import { isJevAgent } from "../agent/isolation.ts";
import type { Resolved } from "../config.ts";
import type { Logger } from "../log.ts";
import type { Module } from "../modules.ts";
import { createContextRouter, createContextWindowLookup } from "../router/context-router.ts";
import { fallbackPlan, hashText, turnPlans, type TurnPlan } from "../router/plan.ts";
import { jevClientFor, type JevClientCtx } from "./jev-client.ts";
import { groupOf, resolveToolGroups, type ToolGroup } from "../router/tool-groups.ts";
import { referencedTools, selectToolRemovals } from "../router/tool-router.ts";
import type { PlanCache } from "../state/session-state.ts";

/** The part of the `context` hook event used here. All fields are mutable on the host side. */
export interface ContextEvent {
  sessionID?: string;
  agent?: string;
  system?: unknown;
  messages?: unknown;
  tools?: unknown;
}

/** Extension point for later tickets (message pruning). Runs before tool filtering; failures are isolated. */
export interface ContextStage {
  name: string;
  apply(event: ContextEvent, plan: TurnPlan): Promise<void> | void;
}

export interface ContextHookDeps {
  options: Pick<Resolved, "alwaysKeepTools" | "toolGroups">;
  log: Pick<Logger, "debug" | "warn">;
  plans: PlanCache<TurnPlan>;
  stages?: readonly ContextStage[];
  now?: () => number;
}

/** First characters of every routing note; also the guard against appending it twice to the same request. */
export const ROUTING_NOTE_MARKER = "[jevCode routing]";
/** Hard cap of the note (AC: short). */
export const ROUTING_NOTE_MAX_CHARS = 600;
/** Skill ids shown in the note are cut to this length. */
const NOTE_ID_MAX = 40;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (isRecord(p) && p.type === "text" && typeof p.text === "string" ? p.text : ""))
    .filter((t) => t !== "")
    .join("\n");
}

/**
 * Candidate turn keys of the latest user message of a request: its id when the host gives one, plus the text hash
 * spelling used by `turnKeyFor` when the prompt hook had no message id. Empty when there is no user message.
 */
export function latestUserKeys(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isRecord(m) || m.role !== "user") continue;
    const keys: string[] = [];
    if (typeof m.id === "string" && m.id !== "") keys.push(m.id);
    const text = textOf(m.content);
    keys.push(`h:${hashText(text)}:${text.length}`);
    return keys;
  }
  return [];
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The routing note (R6.4): selected skills, available tool groups, and the groups left out of this request. Always
 * `<= ROUTING_NOTE_MAX_CHARS` and always starts with `ROUTING_NOTE_MARKER`.
 */
export function buildRoutingNote(plan: TurnPlan, removedGroups: readonly string[] = []): string {
  if (plan.source !== "jev") return `${ROUTING_NOTE_MARKER} No routing plan for this request; all tools are available.`;
  const parts: string[] = [];
  if (plan.skills.length > 0) parts.push(`Skills selected for this request: ${plan.skills.map((s) => clip(s, NOTE_ID_MAX)).join(", ")}.`);
  const available = plan.tools.groups.filter((g) => !removedGroups.includes(g));
  if (available.length > 0) parts.push(`Tool groups available: ${available.join(", ")}.`);
  if (removedGroups.length > 0) parts.push(`Not needed for this request and left out: ${removedGroups.join(", ")}.`);
  if (parts.length === 0) parts.push("All tools are available.");
  return clip(`${ROUTING_NOTE_MARKER} ${parts.join(" ")}`, ROUTING_NOTE_MAX_CHARS);
}

/** Appends the note as a new `system` part (existing parts are untouched). No-op if already there. */
function appendNote(system: unknown, note: string): boolean {
  if (!Array.isArray(system)) return false;
  if (system.some((p) => isRecord(p) && typeof p.text === "string" && p.text.startsWith(ROUTING_NOTE_MARKER))) return false;
  system.push({ type: "text", text: note });
  return true;
}

/** Deletes `ids` from `tools`; on any failure puts everything back. Returns the removed ids. */
function deleteTools(tools: Record<string, unknown>, ids: readonly string[]): string[] {
  const saved = new Map<string, unknown>();
  try {
    for (const id of ids) {
      saved.set(id, tools[id]);
      delete tools[id];
    }
    return [...saved.keys()];
  } catch {
    for (const [id, value] of saved) {
      try {
        tools[id] = value;
      } catch {
        // nothing more to do
      }
    }
    return [];
  }
}

/** Builds the `context` hook callback. The returned function never throws. */
export function createContextHook(deps: ContextHookDeps): (event: ContextEvent) => Promise<void> {
  const { options, log, plans } = deps;
  const now = deps.now ?? Date.now;
  const groups: ToolGroup[] = resolveToolGroups(options.toolGroups);
  const alwaysKeep = options.alwaysKeepTools;

  function planFor(event: ContextEvent, sessionID: string): TurnPlan {
    const keys = latestUserKeys(event.messages);
    for (const key of keys) {
      const plan = plans.getForTurn(sessionID, key);
      if (plan) return plan;
    }
    return fallbackPlan(sessionID, keys[0] ?? "", keys.length === 0 ? "no user message in the request" : "stale or missing plan", now());
  }

  return async function onContext(event: ContextEvent): Promise<void> {
    try {
      if (!isJevAgent(event?.agent)) return;
      const sessionID = typeof event.sessionID === "string" ? event.sessionID : "";
      const plan = planFor(event, sessionID);

      for (const stage of deps.stages ?? []) {
        try {
          await stage.apply(event, plan);
        } catch (err) {
          log.warn(`context stage ${stage.name} failed; continuing without it:`, err);
        }
      }

      let removedGroups: string[] = [];
      if (isRecord(event.tools) && plan.tools.excluded.length > 0) {
        const tools = event.tools;
        const removals = selectToolRemovals({
          toolIds: Object.keys(tools),
          excludedGroups: plan.tools.excluded,
          groups,
          alwaysKeep,
          referenced: referencedTools(event.messages),
        });
        const removed = removals.length > 0 ? deleteTools(tools, removals) : [];
        removedGroups = [...new Set(removed.map((id) => groupOf(id, groups)).filter((g): g is string => g !== undefined))];
        if (removed.length > 0) log.debug(`context: removed ${removed.length} tool(s) of ${removedGroups.join(", ")}`);
      }

      appendNote(event.system, buildRoutingNote(plan, removedGroups));
    } catch (err) {
      try {
        log.warn("context hook failed; the request is left as it is:", err);
      } catch {
        // never throw
      }
    }
  };
}

/** Structural subset of the host `Context` used by the context hook module. */
export interface ContextHookCtx extends JevClientCtx {
  readonly session: {
    hook(name: "context", callback: (event: ContextEvent) => Promise<void> | void): Promise<{ dispose(): Promise<void> | void }>;
  };
}

/** Wiring entry for MODULES. Returns the hook registration so cleanup unregisters it. */
export const contextHookModule: Module<ContextHookCtx> = {
  name: "context-hook",
  async init(ctx, { options, log }) {
    let stages: ContextStage[] = [];
    try {
      stages = [
        createContextRouter({
          options,
          log,
          client: jevClientFor(ctx, options, log),
          contextWindow: createContextWindowLookup(() => ctx.model.list()),
        }),
      ];
    } catch (err) {
      log.warn("context pruning is unavailable; tool filtering still runs:", err);
    }
    const callback = createContextHook({ options, log, plans: turnPlans, stages });
    return ctx.session.hook("context", callback);
  },
};
