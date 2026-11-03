/**
 * Safe message pruning (story R5.3/R5.4, design D7 and "Unit grouping and safety invariants").
 *
 * `analyze` groups messages into units and marks the FORCED ones; `applyDrop` builds a NEW array without the dropped
 * (non-forced) units and runs the post-condition `checkPrune`. If the check fails the prune is discarded (`null`) and
 * the caller keeps the original messages. The input array and its messages are never mutated.
 *
 * Forced (always kept): system messages, the leading messages before the first user message, the latest user message
 * and everything after it, the last `keepRecentMessages`, messages with a compaction part, the first user message when
 * `keepFirstUser`, and anything that is not a message object. A unit is forced when any of its messages is.
 */
import { isRecord } from "./collector.ts";
import { findOrphans, groupMessages, hasCompactionPart, type MessageUnit } from "./message-groups.ts";

export interface PruneOptions {
  keepRecentMessages: number;
  keepFirstUser: boolean;
  unitMaxTokens?: number;
}

export interface Analysis {
  units: MessageUnit[];
  /** Parallel to `units`. */
  forced: boolean[];
  /** Message indexes that must be in the output. */
  forcedMessages: Set<number>;
  /** Index of the latest user message. */
  latestUser: number;
}

const role = (m: unknown): string | undefined => (isRecord(m) && typeof m.role === "string" ? m.role : undefined);

/** Groups the messages and marks forced units. `null` when there is nothing safe to prune (no user message, not an array). */
export function analyze(messages: unknown, opts: PruneOptions): Analysis | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  let latestUser = -1;
  let firstUser = -1;
  messages.forEach((m, i) => {
    if (role(m) !== "user") return;
    if (firstUser < 0) firstUser = i;
    latestUser = i;
  });
  if (latestUser < 0) return null;

  const forcedMessages = new Set<number>();
  const keepRecent = Number.isFinite(opts.keepRecentMessages) ? Math.max(0, Math.floor(opts.keepRecentMessages)) : 0;
  messages.forEach((m, i) => {
    const r = role(m);
    if (!isRecord(m) || r === "system" || i < firstUser || i >= latestUser || i >= messages.length - keepRecent || hasCompactionPart(m)) {
      forcedMessages.add(i);
    }
  });
  if (opts.keepFirstUser) forcedMessages.add(firstUser);

  const units = groupMessages(messages, { unitMaxTokens: opts.unitMaxTokens });
  const forced = units.map((u) => {
    for (let i = u.start; i < u.end; i++) if (forcedMessages.has(i)) return true;
    return false;
  });
  // A forced unit keeps all its messages, so they all count as forced messages.
  units.forEach((u, k) => {
    if (forced[k]) for (let i = u.start; i < u.end; i++) forcedMessages.add(i);
  });
  return { units, forced, forcedMessages, latestUser };
}

/** Post-condition of a prune. Returns a reason when the output is not acceptable, else `null`. */
export function checkPrune(original: readonly unknown[], kept: readonly boolean[], forcedMessages: ReadonlySet<number>, latestUser: number): string | null {
  for (const i of forcedMessages) if (!kept[i]) return `forced message ${i} was dropped`;
  for (let i = Math.max(0, latestUser); i < original.length; i++) if (!kept[i]) return `message ${i} at or after the latest user message was dropped`;
  const output = original.filter((_, i) => kept[i]);
  const before = new Set(findOrphans(original));
  const orphan = findOrphans(output).find((o) => !before.has(o));
  if (orphan) return `orphan tool part ${orphan}`;
  const firstRole = (list: readonly unknown[]) => list.map(role).find((r) => r !== "system");
  if (firstRole(original) !== firstRole(output)) return "the first non-system message changed role";
  return null;
}

export interface DropResult {
  /** The messages to send: the ORIGINAL array when nothing was dropped, else a new array of the same message objects. */
  messages: unknown[];
  /** Ids of the dropped units. */
  dropped: string[];
  droppedTokens: number;
}

/**
 * Drops the non-forced units whose id is in `drop`. `null` when the analysis is impossible or the post-condition
 * fails (the caller then uses the original messages). Forced units are never dropped, whatever `drop` contains.
 */
export function applyDrop(messages: unknown, drop: ReadonlySet<string>, opts: PruneOptions, analysis: Analysis | null = analyze(messages, opts)): DropResult | null {
  try {
    if (!analysis || !Array.isArray(messages)) return null;
    const kept = new Array<boolean>(messages.length).fill(true);
    const dropped: string[] = [];
    let droppedTokens = 0;
    analysis.units.forEach((u, k) => {
      if (analysis.forced[k] || !drop.has(u.id)) return;
      for (let i = u.start; i < u.end; i++) kept[i] = false;
      dropped.push(u.id);
      droppedTokens += u.tokens;
    });
    if (dropped.length === 0) return { messages, dropped, droppedTokens: 0 };
    const problem = checkPrune(messages, kept, analysis.forcedMessages, analysis.latestUser);
    if (problem) return null;
    return { messages: messages.filter((_, i) => kept[i]), dropped, droppedTokens };
  } catch {
    return null;
  }
}
