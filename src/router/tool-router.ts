/**
 * Tool group routing (story R4, design D5/F7).
 *
 * Stage A (prompt hook): one independent `noul` per tool group joins the batched Jev request. Groups whose
 * (clamped) probability is below `toolThreshold` become EXCLUDED in the plan; groups without a usable answer are
 * kept. Stage B (context hook, see `src/opencode/context-hook.ts`): `selectToolRemovals` decides which keys of
 * `event.tools` to delete. Removing a tool from a request only shapes the request (R4.4); the host's access rules are
 * neither read nor changed here.
 */
import type { Resolved } from "../config.ts";
import { TOOL_QUESTION_PREFIX, toolGroupQuestion } from "../jev/questions.ts";
import { noulProbability } from "../jev/response.ts";
import type { Answers, Questions } from "../jev/types.ts";
import type { Logger } from "../log.ts";
import type { StageAContributor, StageAOutcome, TurnPlan } from "./plan.ts";
import { askableGroups, groupOf, matchesAny, resolveToolGroups, type ToolGroup } from "./tool-groups.ts";

/** Contributor name (used in fallback reasons). */
export const TOOL_CONTRIBUTOR = "tools";

export interface ToolDecision {
  /** Asked groups that stay available (above the threshold, or unanswered). */
  groups: string[];
  /** Asked groups Jev judged not needed. */
  excluded: string[];
  /** Number of groups with a usable answer. */
  answered: number;
}

/**
 * Applies answers to the closed set of asked groups. Only `tools:<group>` keys of asked groups are read; a missing,
 * wrong-kind or NaN answer keeps the group. Never throws.
 */
export function decideTools(answers: Answers | null | undefined, asked: readonly string[], threshold: number): ToolDecision {
  const groups: string[] = [];
  const excluded: string[] = [];
  let answered = 0;
  for (const name of asked) {
    const p = answers ? noulProbability(answers[`${TOOL_QUESTION_PREFIX}${name}`]) : null;
    if (p === null) {
      groups.push(name);
      continue;
    }
    answered++;
    if (p < threshold) excluded.push(name);
    else groups.push(name);
  }
  return { groups, excluded, answered };
}

export interface ToolRouterDeps {
  options: Pick<Resolved, "toolThreshold" | "toolGroups">;
  log: Pick<Logger, "debug" | "warn">;
}

/** Stage-A contributor for tool groups. */
export function createToolRouter(deps: ToolRouterDeps): StageAContributor {
  const groups = askableGroups(resolveToolGroups(deps.options.toolGroups));
  return {
    name: TOOL_CONTRIBUTOR,
    prepare() {
      if (groups.length === 0) return { skip: "no tool groups" };
      const questions: Questions = {};
      for (const g of groups) questions[`${TOOL_QUESTION_PREFIX}${g.name}`] = toolGroupQuestion(g);
      const asked = groups.map((g) => g.name);
      return {
        questions,
        apply(answers: Answers | null, plan: TurnPlan): StageAOutcome {
          if (!answers) return { decided: false, reason: "Jev unavailable" };
          const d = decideTools(answers, asked, deps.options.toolThreshold);
          if (d.answered === 0) return { decided: false, reason: "no usable tool group answer" };
          plan.tools = { groups: d.groups, excluded: d.excluded };
          return { decided: true };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Stage B helpers (pure; used by the context hook)
// ---------------------------------------------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Names of the tools that `tool-call` / `tool-result` parts of `messages` refer to. A part's `name` and, when it has a
 * `namespace`, the usual joined spellings are all included so the matching key of `event.tools` is found.
 */
export function referencedTools(messages: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(messages)) return out;
  for (const m of messages) {
    const content = isRecord(m) ? m.content : undefined;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part) || (part.type !== "tool-call" && part.type !== "tool-result")) continue;
      const name = part.name;
      if (typeof name !== "string" || name === "") continue;
      out.add(name);
      const ns = part.namespace;
      if (typeof ns === "string" && ns !== "") for (const sep of ["_", "/", ".", "-"]) out.add(`${ns}${sep}${name}`);
    }
  }
  return out;
}

export interface ToolRemovalInput {
  /** Keys of `event.tools`. */
  toolIds: readonly string[];
  /** Group names the plan excluded. */
  excludedGroups: readonly string[];
  groups: readonly ToolGroup[];
  alwaysKeep: readonly string[];
  /** Tools referenced by messages that stay in the request. */
  referenced: ReadonlySet<string>;
}

/**
 * Tool ids to delete: tools of an excluded group that are not always-keep, not referenced by the request's messages,
 * and not ungrouped. Empty when removing them would leave no tool at all (R4.3). Never throws.
 */
export function selectToolRemovals(input: ToolRemovalInput): string[] {
  const excluded = new Set(input.excludedGroups);
  if (excluded.size === 0) return [];
  const removals: string[] = [];
  for (const id of input.toolIds) {
    const group = groupOf(id, input.groups);
    if (group === undefined || !excluded.has(group)) continue;
    if (input.referenced.has(id) || matchesAny(input.alwaysKeep, id)) continue;
    removals.push(id);
  }
  return removals.length >= input.toolIds.length ? [] : removals;
}
