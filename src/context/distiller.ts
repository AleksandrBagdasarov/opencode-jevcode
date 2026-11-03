/**
 * Builds the compact ConversationState sent to Jev (story R5.1): never the transcript, only the objective, the
 * current request, a few active files / completed items / issues and one short line per context candidate. The
 * serialised state is guaranteed to stay under `maxChars` (default `DISTILL_MAX_CHARS`, below the client cap).
 */
import { clip, collectActiveFiles, collectCompletedWork, collectUnresolvedIssues, isRecord, textOfMessage } from "./collector.ts";

/** Default cap of the serialised state; the Jev client cuts state at 12000 chars, so stay clear of that. */
export const DISTILL_MAX_CHARS = 9000;

export interface ContextCandidate {
  /** Question group id (a unit id, or an id for merged units). */
  id: string;
  summary: string;
  tokens: number;
}

export interface ConversationState {
  objective: string;
  currentRequest: string;
  activeFiles: string[];
  completedWork: string[];
  unresolvedIssues: string[];
  contextCandidates: ContextCandidate[];
  totalTokens: number;
}

export interface DistillInput {
  messages: readonly unknown[];
  candidates: readonly ContextCandidate[];
  totalTokens: number;
  maxChars?: number;
}

export interface Distilled {
  state: ConversationState;
  /** Candidates that made it into the state (all of them unless the cap forced the oldest ones out). */
  included: ContextCandidate[];
}

const size = (state: ConversationState): number => {
  try {
    return JSON.stringify(state).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

/** First and latest user message text. */
function userTexts(messages: readonly unknown[]): { objective: string; current: string } {
  let objective = "";
  let current = "";
  for (const m of messages) {
    if (!isRecord(m) || m.role !== "user") continue;
    const text = textOfMessage(m);
    if (text === "") continue;
    if (objective === "") objective = text;
    current = text;
  }
  return { objective, current };
}

/** Builds the state and shrinks it step by step until it fits `maxChars`. Never throws. */
export function distill(input: DistillInput): Distilled {
  const maxChars = typeof input.maxChars === "number" && input.maxChars > 500 ? input.maxChars : DISTILL_MAX_CHARS;
  try {
    return build(input, maxChars);
  } catch {
    return { state: emptyState(input.totalTokens), included: [] };
  }
}

const emptyState = (totalTokens: number): ConversationState => ({
  objective: "",
  currentRequest: "",
  activeFiles: [],
  completedWork: [],
  unresolvedIssues: [],
  contextCandidates: [],
  totalTokens,
});

function build(input: DistillInput, maxChars: number): Distilled {
  const { objective, current } = userTexts(input.messages);
  let candidates = input.candidates.map((c) => ({ id: c.id, summary: c.summary, tokens: c.tokens }));
  const state: ConversationState = {
    objective: clip(objective, 400),
    currentRequest: clip(current, 600),
    activeFiles: collectActiveFiles(input.messages, 12),
    completedWork: collectCompletedWork(input.messages, 10),
    unresolvedIssues: collectUnresolvedIssues(input.messages, 5),
    contextCandidates: candidates,
    totalTokens: input.totalTokens,
  };

  const steps: Array<() => void> = [
    () => (state.contextCandidates = candidates = candidates.map((c) => ({ ...c, summary: clip(c.summary, 100) }))),
    () => (state.completedWork = state.completedWork.slice(-5).map((s) => clip(s, 70))),
    () => (state.activeFiles = state.activeFiles.slice(0, 6).map((s) => clip(s, 80))),
    () => (state.unresolvedIssues = state.unresolvedIssues.slice(0, 3).map((s) => clip(s, 80))),
    () => (state.contextCandidates = candidates = candidates.map((c) => ({ ...c, summary: clip(c.summary, 48) }))),
    () => {
      state.objective = clip(state.objective, 160);
      state.currentRequest = clip(state.currentRequest, 240);
    },
    () => {
      state.completedWork = [];
      state.activeFiles = state.activeFiles.slice(0, 3);
      state.unresolvedIssues = state.unresolvedIssues.slice(0, 1);
    },
    () => (state.contextCandidates = candidates = candidates.map((c) => ({ ...c, summary: clip(c.summary, 16) }))),
  ];
  for (const step of steps) {
    if (size(state) <= maxChars) break;
    step();
  }
  // Last resort: the oldest candidates go first (they stay unanswered, hence kept by the router).
  while (size(state) > maxChars && candidates.length > 0) {
    candidates = candidates.slice(1);
    state.contextCandidates = candidates;
  }
  if (size(state) > maxChars) {
    state.objective = clip(state.objective, 60);
    state.currentRequest = clip(state.currentRequest, 120);
    state.activeFiles = [];
    state.unresolvedIssues = [];
  }
  return { state, included: candidates };
}
