/**
 * TurnPlan (design section 4) and the contract that lets several routers (model now; skills and tool
 * groups in later tickets) contribute questions to the SAME batched Jev request in stage A (R6.1).
 */
import type { Answers, Questions } from "../jev/types.ts";
import { createPlanCache, type ModelRef, type PlanCache } from "../state/session-state.ts";

export interface TurnPlan {
  sessionID: string;
  /** Latest user message id; else a hash of the prompt text. */
  turnKey: string;
  createdAt: number;
  source: "jev" | "fallback";
  fallbackReason?: string;
  /** Absent = keep the current model. */
  model?: { providerID: string; id: string; confidence: number };
  /** Validated skill ids (filled by the skill router). */
  skills: string[];
  tools: { groups: string[]; excluded: string[] };
  /**
   * Set by the context router (stage B) when it pruned. `droppedUnitIds` lets continuations re-apply exactly the same
   * drops (units not listed, e.g. messages appended during the turn, are kept). `maxTokens` 0 = no budget known.
   */
  context?: { keepUnitIds: string[]; droppedUnitIds?: string[]; maxTokens: number; confidence: number };
}

/**
 * The plan cache shared by the prompt hook (writer) and the context hook (reader, ticket 0006).
 * One plan per session; a new prompt replaces it.
 */
export const turnPlans: PlanCache<TurnPlan> = createPlanCache<TurnPlan>();

/** Deterministic plan used whenever Jev is unavailable or undecided: keep model, no skills, all tools. */
export function fallbackPlan(sessionID: string, turnKey: string, reason: string, now: number = Date.now()): TurnPlan {
  return {
    sessionID,
    turnKey,
    createdAt: now,
    source: "fallback",
    fallbackReason: reason,
    skills: [],
    tools: { groups: [], excluded: [] },
  };
}

/** Small stable string hash (FNV-1a, 32 bit) - enough to tell prompts apart; not security relevant. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The id of the prompt's user message; if the host gave none, a hash of the text. */
export function turnKeyFor(messageID: unknown, text: string): string {
  return typeof messageID === "string" && messageID !== "" ? messageID : `h:${hashText(text)}:${text.length}`;
}

/** What a contributor sees when the prompt hook prepares stage A. */
export interface StageAInput {
  sessionID: string;
  turnKey: string;
  /** User prompt text. */
  text: string;
  /** Session model before routing; always known here (the hook skips routing otherwise). */
  current: ModelRef;
  /**
   * The mutable prompt of the hook event. Skill routing (ticket 0005) appends `{ id }` entries to
   * `prompt.skills`; the model router only reads it.
   */
  prompt: { text?: string; skills?: unknown[]; files?: unknown[] };
}

/** Outcome of applying answers: whether Jev made a positive decision, and why not otherwise. */
export interface StageAOutcome {
  decided: boolean;
  reason?: string;
}

export interface StageAPrepared {
  /** Question names must be unique across contributors: prefix them (`model`, `skill:<id>`, `tools:<group>`). */
  questions: Questions;
  /**
   * Called once with the batched answers (`null` = Jev failed or is unavailable). Fills the plan.
   * Absent answer keys mean "unanswered". Must apply code-side validation (design D5).
   */
  apply(answers: Answers | null, plan: TurnPlan): StageAOutcome | Promise<StageAOutcome>;
}

export interface StageASkip {
  skip: string;
}

export interface StageAContributor {
  name: string;
  /** Never needs to throw: the hook guards it, and a throw only drops this contributor. */
  prepare(input: StageAInput): Promise<StageAPrepared | StageASkip> | StageAPrepared | StageASkip;
}
