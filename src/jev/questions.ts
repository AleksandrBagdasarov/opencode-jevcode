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
