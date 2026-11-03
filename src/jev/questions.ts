/** Small generic builders. Domain questions (model/skills/tools/context) are added by the router tickets. */

import type { Question } from "./types.ts";

export function choiceQuestion(instructions: string, options: Record<string, string>): Question {
  return { kind: "choice", instructions, options };
}

export function noulQuestion(instructions: string): Question {
  return { kind: "noul", instructions };
}

export function scoreQuestion(instructions: string, levels: string[]): Question {
  return { kind: "score", instructions, levels };
}

/** Question-name prefix of the per-tool-group `noul` questions in the batched request. */
export const TOOL_QUESTION_PREFIX = "tools:";

/** One `noul` per tool group (story R4.1): "does this request need tools of this group?". Only group metadata is sent. */
export function toolGroupQuestion(group: { name: string; description?: string }): Question {
  const parts = [`Will the coding request in the state need tools of the group "${group.name.slice(0, 80)}"?`];
  if (group.description) parts.push(`Group: ${group.description.slice(0, 200)}`);
  parts.push("Answer with the probability that the assistant needs at least one tool of this group to complete the request.");
  return noulQuestion(parts.join(" "));
}

/** Question-name prefix of the per-unit `score` questions of the context relevance request (stage B). */
export const CONTEXT_QUESTION_PREFIX = "unit:";
/** Relevance scale 0..4 of a conversation unit; the last index is the maximum score. */
export const CONTEXT_SCORE_LEVELS = ["irrelevant", "marginal", "somewhat relevant", "relevant", "essential"];

/**
 * One `score` question per conversation unit (story R5.2): how relevant is this part of the history to the current
 * request. The unit itself is described in the state's `contextCandidates`; only its id and a short summary go here.
 */
export function contextUnitQuestion(unit: { id: string; summary?: string }): Question {
  const parts = [`How relevant is the earlier conversation unit "${unit.id.slice(0, 80)}" listed in contextCandidates to the currentRequest in the state?`];
  if (unit.summary) parts.push(`Unit: ${unit.summary.slice(0, 120)}`);
  parts.push("0 = irrelevant and safe to leave out, 4 = essential for the current request.");
  return scoreQuestion(parts.join(" "), CONTEXT_SCORE_LEVELS);
}

/** Question-name prefix of the per-skill `noul` questions in the batched request. */
export const SKILL_QUESTION_PREFIX = "skill:";

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * One independent `noul` question per shortlisted skill (story R3.1): "does this request need this skill?".
 * Only metadata is sent (name, description, a short capability line); never the skill's Markdown.
 */
export function skillQuestion(skill: { name: string; description?: string; capability?: string }): Question {
  const parts = [`Does the coding request in the state need the skill "${cut(skill.name, 80)}"?`];
  if (skill.description) parts.push(`Description: ${cut(skill.description, 300)}`);
  if (skill.capability) parts.push(`Capability: ${cut(skill.capability, 200)}`);
  parts.push("Answer with the probability that loading this skill will help.");
  return noulQuestion(parts.join(" "));
}
