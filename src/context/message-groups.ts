/**
 * Groups `event.messages` into logical UNITS (story R5.1, design section 5 "Unit grouping").
 *
 * A unit is a contiguous range of messages: a user message plus the assistant/tool messages that answer it, up to the
 * next user message (messages before the first user message form a leading unit). A `tool-call` and its
 * `tool-result` (matched by part id) are indivisible: units that an id spans are merged, so pruning whole units can
 * never separate a pair. A unit that exceeds the size cap is split further, only at points no pair crosses.
 *
 * Units have stable ids (the first message's id, else index + text hash), token estimates and a short summary.
 * Nothing here mutates its input. Every function is total (never throws).
 */
import { hashText } from "../router/plan.ts";
import { clip, filesOfInput, isRecord, partsOf, textOfMessage } from "./collector.ts";
import { charLength, tokensFromChars } from "./token-budget.ts";

export interface MessageUnit {
  /** Stable id: the first message's id when the host gives one, else `m<index>-<hash>`. Unique within a call. */
  id: string;
  /** First message index (inclusive). */
  start: number;
  /** Last message index (exclusive). */
  end: number;
  tokens: number;
  /** One short line (<= SUMMARY_MAX_CHARS): the user text, the tools used and the files touched. */
  summary: string;
}

export interface GroupOptions {
  /** Units above this many estimated tokens are split further. Default `DEFAULT_UNIT_MAX_TOKENS`. */
  unitMaxTokens?: number;
}

export const DEFAULT_UNIT_MAX_TOKENS = 6000;
export const SUMMARY_MAX_CHARS = 160;
/** Overhead of a message envelope in tokens. */
const MESSAGE_OVERHEAD = 4;

/** Estimated tokens of one message (a non-object counts as 1). */
export function messageTokens(message: unknown): number {
  if (!isRecord(message)) return 1;
  let chars = 0;
  const content = message.content;
  if (typeof content === "string") chars = content.length;
  else if (Array.isArray(content)) for (const part of content) chars += charLength(part);
  return MESSAGE_OVERHEAD + tokensFromChars(chars);
}

/** True when a message has a compaction part. */
export function hasCompactionPart(message: unknown): boolean {
  return partsOf(message).some((p) => p.type === "compaction");
}

/** Ids of tool-call / tool-result parts of a message. */
function toolPartIds(message: unknown): string[] {
  const ids: string[] = [];
  for (const p of partsOf(message)) {
    if ((p.type === "tool-call" || p.type === "tool-result") && typeof p.id === "string" && p.id !== "") ids.push(p.id);
  }
  return ids;
}

/**
 * Tool ids that are orphans: a `tool-result` with no `tool-call` of the same id in the same or an earlier message, or
 * a `tool-call` with no `tool-result` in the same or a later message. Entries look like `result:<id>` / `call:<id>`.
 */
export function findOrphans(messages: readonly unknown[]): string[] {
  const calls = new Map<string, number[]>();
  const results = new Map<string, number[]>();
  messages.forEach((m, i) => {
    for (const p of partsOf(m)) {
      if (typeof p.id !== "string" || p.id === "") continue;
      const bucket = p.type === "tool-call" ? calls : p.type === "tool-result" ? results : undefined;
      if (!bucket) continue;
      const list = bucket.get(p.id) ?? [];
      list.push(i);
      bucket.set(p.id, list);
    }
  });
  const orphans: string[] = [];
  for (const [id, at] of results) {
    const first = calls.get(id)?.[0];
    if (first === undefined || first > Math.max(...at)) orphans.push(`result:${id}`);
  }
  for (const [id, at] of calls) {
    const last = results.get(id)?.at(-1);
    if (last === undefined || last < Math.min(...at)) orphans.push(`call:${id}`);
  }
  return orphans;
}

function summarize(messages: readonly unknown[], start: number, end: number): string {
  let user = "";
  const tools = new Map<string, number>();
  const files: string[] = [];
  for (let i = start; i < end; i++) {
    const m = messages[i];
    if (!isRecord(m)) continue;
    if (!user && m.role === "user") user = clip(textOfMessage(m), 80);
    for (const p of partsOf(m)) {
      if (p.type !== "tool-call") continue;
      const name = typeof p.name === "string" && p.name !== "" ? clip(p.name, 24) : "tool";
      tools.set(name, (tools.get(name) ?? 0) + 1);
      for (const f of filesOfInput(p.input)) if (files.length < 2 && !files.includes(f)) files.push(clip(f, 40));
    }
  }
  const parts: string[] = [];
  if (user) parts.push(`"${user}"`);
  else {
    const head = messages[start];
    const role = isRecord(head) && typeof head.role === "string" ? head.role : "message";
    parts.push(`${role} (${end - start} msg)`);
  }
  if (tools.size > 0) {
    parts.push(
      `tools: ${[...tools]
        .slice(0, 3)
        .map(([n, c]) => (c > 1 ? `${n}x${c}` : n))
        .join(", ")}`,
    );
  }
  if (files.length > 0) parts.push(`files: ${files.join(", ")}`);
  return clip(parts.join(" | "), SUMMARY_MAX_CHARS);
}

/** Groups messages into contiguous units covering every message exactly once. Never throws (garbage in => one unit). */
export function groupMessages(messages: readonly unknown[], opts: GroupOptions = {}): MessageUnit[] {
  try {
    return group(messages, opts);
  } catch {
    return messages.length === 0
      ? []
      : [{ id: "m0-all", start: 0, end: messages.length, tokens: 0, summary: "conversation" }];
  }
}

function group(messages: readonly unknown[], opts: GroupOptions): MessageUnit[] {
  const n = messages.length;
  if (n === 0) return [];
  const cap = typeof opts.unitMaxTokens === "number" && opts.unitMaxTokens > 0 ? opts.unitMaxTokens : DEFAULT_UNIT_MAX_TOKENS;
  const tokens = messages.map(messageTokens);

  // crossing[i] = some tool id has parts in messages before i AND at/after i (a cut before i would split a pair)
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  messages.forEach((m, i) => {
    for (const id of toolPartIds(m)) {
      if (!first.has(id)) first.set(id, i);
      last.set(id, i);
    }
  });
  const diff = new Array<number>(n + 2).fill(0);
  for (const [id, lo] of first) {
    const hi = last.get(id)!;
    if (hi > lo) {
      diff[lo + 1]! += 1;
      diff[hi + 1]! -= 1;
    }
  }
  const crossing: boolean[] = new Array(n + 1).fill(false);
  let run = 0;
  for (let i = 0; i <= n; i++) {
    run += diff[i]!;
    crossing[i] = run > 0;
  }

  // 1. cut before every user message (except at 0), unless a tool pair crosses
  const cuts: number[] = [0];
  messages.forEach((m, i) => {
    if (i > 0 && isRecord(m) && m.role === "user" && !crossing[i]) cuts.push(i);
  });
  cuts.push(n);

  // 2. split oversized ranges at pair-free points
  const bounds: number[] = [0];
  for (let c = 0; c + 1 < cuts.length; c++) {
    const lo = cuts[c]!;
    const hi = cuts[c + 1]!;
    let total = 0;
    for (let i = lo; i < hi; i++) total += tokens[i]!;
    if (total > cap) {
      let acc = 0;
      for (let i = lo; i < hi; i++) {
        acc += tokens[i]!;
        if (acc >= cap && i + 1 < hi && !crossing[i + 1]) {
          bounds.push(i + 1);
          acc = 0;
        }
      }
    }
    bounds.push(hi);
  }

  // 3. build units with unique stable ids
  const seen = new Set<string>();
  const units: MessageUnit[] = [];
  for (let b = 0; b + 1 < bounds.length; b++) {
    const start = bounds[b]!;
    const end = bounds[b + 1]!;
    if (end <= start) continue;
    const head = messages[start];
    let id = isRecord(head) && typeof head.id === "string" && head.id !== "" ? head.id : `m${start}-${hashText(textOfMessage(head))}`;
    if (seen.has(id)) {
      let k = 2;
      while (seen.has(`${id}~${k}`)) k++;
      id = `${id}~${k}`;
    }
    seen.add(id);
    let sum = 0;
    for (let i = start; i < end; i++) sum += tokens[i]!;
    units.push({ id, start, end, tokens: sum, summary: summarize(messages, start, end) });
  }
  return units;
}

/** Estimated tokens of a whole conversation. */
export function conversationTokens(messages: readonly unknown[]): number {
  let total = 0;
  for (const m of messages) total += messageTokens(m);
  return total;
}
