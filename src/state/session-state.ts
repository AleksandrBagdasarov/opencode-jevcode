/**
 * Per-session state. This file currently holds ONLY the model-restore memory (story R1.5, design
 * "Isolation and restore"). A later ticket adds the turn-plan cache to this file; keep that logic
 * separate from `createRestoreMemory` and the restore functions below.
 *
 * Nothing exported here throws: hooks call these on the hot path and must fail open.
 */
import type { Logger } from "../log.ts";
import { unwrapSession } from "../agent/isolation.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Structural subset of `ctx.storage` (durable JSON per plugin id, design F14). */
export interface StorageLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: Json): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/** `previous` = model before Jev routing; `applied` = model the router switched the session to. */
export interface RestoreEntry {
  previous: ModelRef;
  applied: ModelRef;
}

export interface RestoreMemory {
  remember(sessionID: string, entry: RestoreEntry): Promise<void>;
  peek(sessionID: string): Promise<RestoreEntry | undefined>;
  clear(sessionID: string): Promise<void>;
}

/** Storage keys are namespaced so later tickets can add `plan/...`, `analytics/...` beside them. */
export const restoreKey = (sessionID: string): string => `restore/${sessionID}`;

/** Normalise any host model value into a `ModelRef`; `undefined` when it does not look like one. */
export function toModelRef(value: unknown): ModelRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { providerID?: unknown; id?: unknown; variant?: unknown };
  if (typeof v.providerID !== "string" || v.providerID === "" || typeof v.id !== "string" || v.id === "") return undefined;
  const ref: ModelRef = { providerID: v.providerID, id: v.id };
  if (typeof v.variant === "string" && v.variant !== "") ref.variant = v.variant;
  return ref;
}

/** Same provider, id and variant (a missing variant equals a missing variant). */
export function sameModel(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  if (!a || !b) return false;
  return a.providerID === b.providerID && a.id === b.id && (a.variant ?? "") === (b.variant ?? "");
}

function toEntry(value: unknown): RestoreEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const previous = toModelRef((value as { previous?: unknown }).previous);
  const applied = toModelRef((value as { applied?: unknown }).applied);
  return previous && applied ? { previous, applied } : undefined;
}

/** JSON-safe copy (no `undefined` values). */
function serialize(entry: RestoreEntry): Json {
  const model = (m: ModelRef): Json => (m.variant ? { providerID: m.providerID, id: m.id, variant: m.variant } : { providerID: m.providerID, id: m.id });
  return { previous: model(entry.previous), applied: model(entry.applied) };
}

/** Restore memory backed by `ctx.storage`. Corrupt entries read as "no memory" and are removed. */
export function createRestoreMemory(storage: StorageLike, log?: Pick<Logger, "warn">): RestoreMemory {
  return {
    async remember(sessionID, entry) {
      try {
        await storage.set(restoreKey(sessionID), serialize(entry));
      } catch (err) {
        log?.warn("could not store restore memory:", err);
      }
    },
    async peek(sessionID) {
      try {
        const raw = await storage.get(restoreKey(sessionID));
        if (raw === undefined || raw === null) return undefined;
        const entry = toEntry(raw);
        if (!entry) await storage.remove(restoreKey(sessionID));
        return entry;
      } catch (err) {
        log?.warn("could not read restore memory:", err);
        return undefined;
      }
    },
    async clear(sessionID) {
      try {
        await storage.remove(restoreKey(sessionID));
      } catch (err) {
        log?.warn("could not clear restore memory:", err);
      }
    },
  };
}

/**
 * What the prompt hook should store when it switches `current` -> `applied`.
 * If the session is still on the model Jev applied earlier (`existing.applied`), the ORIGINAL
 * `previous` is kept, so a chain of routed turns restores to the user's own model. If the user has
 * changed the model since (or there is no memory) the current model becomes the new `previous`.
 */
export function planRemember(existing: RestoreEntry | undefined, current: ModelRef, applied: ModelRef): RestoreEntry {
  const previous = existing && sameModel(existing.applied, current) ? existing.previous : current;
  return { previous, applied };
}

export type RestorePlan = { action: "restore"; model: ModelRef } | { action: "clear" } | { action: "none" };

/**
 * Pure rule: restore only if the session model still equals `applied`; if the user picked another
 * model (or it cannot be determined) only forget the memory. No memory => nothing to do.
 */
export function planRestore(entry: RestoreEntry | undefined, currentModel: ModelRef | undefined): RestorePlan {
  if (!entry) return { action: "none" };
  if (sameModel(entry.applied, currentModel)) return { action: "restore", model: entry.previous };
  return { action: "clear" };
}

/** Structural subset of the host `Context.session`. */
export interface RestoreCtx {
  readonly session: {
    get(input: { sessionID: string }): Promise<unknown>;
    switchModel(input: { sessionID: string; model: ModelRef }): Promise<unknown>;
  };
}

/** Performs `session.switchModel(previous)`. Returns false (never throws) when the switch failed. */
export async function runRestore(
  ctx: RestoreCtx,
  sessionID: string,
  model: ModelRef,
  log?: Pick<Logger, "warn" | "debug">,
): Promise<boolean> {
  try {
    await ctx.session.switchModel({ sessionID, model });
    log?.debug(`restored model ${model.providerID}/${model.id} for session ${sessionID}`);
    return true;
  } catch (err) {
    log?.warn(`could not restore model ${model.providerID}/${model.id}:`, err);
    return false;
  }
}

export type RestoreOutcome = "none" | "restored" | "cleared" | "failed" | "unverified";

/**
 * Called by the prompt hook for a prompt whose active agent is NOT jevCode (R1.5).
 * - no memory: no-op ("none"), without touching the session;
 * - session model == applied: switch back to `previous` and clear ("restored"; also cleared when the
 *   switch fails, to avoid retrying an invalid model on every prompt: "failed");
 * - user changed the model: clear without switching ("cleared");
 * - session cannot be read: keep the memory for the next prompt ("unverified").
 */
export async function restoreIfNeeded(
  ctx: RestoreCtx,
  memory: RestoreMemory,
  sessionID: string,
  log?: Pick<Logger, "warn" | "debug">,
): Promise<RestoreOutcome> {
  try {
    const entry = await memory.peek(sessionID);
    if (!entry) return "none";
    let current: ModelRef | undefined;
    try {
      current = toModelRef(unwrapSession(await ctx.session.get({ sessionID }))?.model);
    } catch (err) {
      log?.warn("could not read session for model restore:", err);
      return "unverified";
    }
    const plan = planRestore(entry, current);
    if (plan.action === "restore") {
      const ok = await runRestore(ctx, sessionID, plan.model, log);
      await memory.clear(sessionID);
      return ok ? "restored" : "failed";
    }
    await memory.clear(sessionID);
    return plan.action === "clear" ? "cleared" : "none";
  } catch (err) {
    log?.warn("model restore failed:", err);
    return "failed";
  }
}

/**
 * Called by the prompt hook for a jevCode prompt BEFORE routing: drops stale memory. If the session
 * is still on `applied` the memory is kept (its `previous` is the user's original model and
 * `planRemember` reuses it); if the user changed the model in between, the memory is cleared.
 */
export async function reconcileOnJevPrompt(
  ctx: Pick<RestoreCtx, "session">,
  memory: RestoreMemory,
  sessionID: string,
  log?: Pick<Logger, "warn">,
): Promise<"none" | "kept" | "cleared" | "unverified"> {
  try {
    const entry = await memory.peek(sessionID);
    if (!entry) return "none";
    let current: ModelRef | undefined;
    try {
      current = toModelRef(unwrapSession(await ctx.session.get({ sessionID }))?.model);
    } catch (err) {
      log?.warn("could not read session to reconcile restore memory:", err);
      return "unverified";
    }
    if (sameModel(entry.applied, current)) return "kept";
    await memory.clear(sessionID);
    return "cleared";
  } catch (err) {
    log?.warn("restore reconcile failed:", err);
    return "unverified";
  }
}
