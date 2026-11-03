/**
 * OpenCode-native transport: `ctx.experimental.generate.decisions` with a model of `type: "decision"`
 * (design F9). Mapping: noul -> predicate, choice -> choices[], score -> levels[].
 */

import { JevNetworkError, JevProtocolError, type Answer, type Answers, type JevTransport, type Questions } from "../types.ts";

export interface NativeModelRef {
  providerID: string;
  id: string;
}

export type NativeQuestion =
  | { type: "predicate"; name: string; instructions: string }
  | { type: "choice"; name: string; instructions: string; choices: Array<{ value: string; description?: string }> }
  | { type: "score"; name: string; instructions: string; levels: Array<{ label: string; description?: string }> };

export interface NativeInput {
  model: NativeModelRef;
  input: Array<{ type: "text"; text: string } | { type: "json"; value: unknown }>;
  questions: NativeQuestion[];
}

/** Shape of `ctx.experimental.generate.decisions` (the 2nd argument is OpenCode's RequestOptions). */
export type GenerateDecisions = (input: any, opts?: { signal?: AbortSignal }) => Promise<unknown>;

export function toNativeQuestions(questions: Questions): NativeQuestion[] {
  return Object.entries(questions).map(([name, q]): NativeQuestion => {
    if (q.kind === "noul") return { type: "predicate", name, instructions: q.instructions };
    if (q.kind === "choice") {
      return {
        type: "choice",
        name,
        instructions: q.instructions,
        choices: Object.entries(q.options).map(([value, description]) => ({ value, description })),
      };
    }
    return { type: "score", name, instructions: q.instructions, levels: q.levels.map((label) => ({ label })) };
  });
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function parseNativeAnswers(result: unknown): Answers {
  const list = isRecord(result) ? result.answers : undefined;
  if (!Array.isArray(list)) throw new JevProtocolError("native response has no answers array");
  const out: Answers = {};
  for (const raw of list) {
    if (!isRecord(raw) || typeof raw.name !== "string") continue;
    out[raw.name] = parseOne(raw);
  }
  return out;
}

function parseOne(raw: Record<string, unknown>): Answer {
  switch (raw.type) {
    case "predicate":
      return isNum(raw.probability) ? { kind: "noul", probability: raw.probability } : { kind: "error", reason: "malformed predicate answer" };
    case "choice": {
      if (!isNum(raw.confidence) || (typeof raw.choice !== "string" && typeof raw.choice !== "boolean")) {
        return { kind: "error", reason: "malformed choice answer" };
      }
      const probabilities: Record<string, number> = {};
      if (Array.isArray(raw.probabilities)) {
        for (const p of raw.probabilities) {
          if (isRecord(p) && isNum(p.probability) && (typeof p.value === "string" || typeof p.value === "boolean")) {
            probabilities[String(p.value)] = p.probability;
          }
        }
      }
      return { kind: "choice", choice: String(raw.choice), confidence: raw.confidence, probabilities };
    }
    case "score":
      return isNum(raw.score) && isNum(raw.confidence)
        ? { kind: "score", score: raw.score, confidence: raw.confidence }
        : { kind: "error", reason: "malformed score answer" };
    case "error": {
      const reason = typeof raw.reason === "string" ? raw.reason : "error";
      return { kind: "error", reason: typeof raw.message === "string" ? `${reason}: ${raw.message}` : reason };
    }
    default:
      return { kind: "error", reason: "unknown answer type" };
  }
}

export function createNativeTransport(cfg: { generateDecisions: GenerateDecisions; model: NativeModelRef }): JevTransport {
  return {
    name: "opencode",
    async ask(state, questions, { signal }) {
      const input: NativeInput = {
        model: { providerID: cfg.model.providerID, id: cfg.model.id },
        input: [typeof state === "string" ? { type: "text", text: state } : { type: "json", value: state }],
        questions: toNativeQuestions(questions),
      };
      let result: unknown;
      try {
        result = await cfg.generateDecisions(input, { signal });
      } catch (e) {
        if (signal.aborted) throw e;
        throw new JevNetworkError(`Jev native call failed: ${e instanceof Error ? e.name : "unknown"}`);
      }
      return parseNativeAnswers(result);
    },
  };
}
