/**
 * Isolation predicate (design D8). Every hook must call `isJevAgent` / `resolveSessionAgent` and
 * return before touching state when the active agent is not jevCode.
 */
import type { Resolved } from "../config.ts";
import { JEV_AGENT_ID } from "./definition.ts";

/** The single predicate: exact match on the agent id, nothing fuzzy (`jevcode`, `jevCode2` are NOT jev). */
export function isJevAgent(id: unknown): boolean {
  return id === JEV_AGENT_ID;
}

/** Structural subset of the host `Context` used here. */
export interface SessionCtx {
  readonly session: {
    /** Observed on 2.2.5: resolves to the `SessionInfo` itself; `{ data }` is tolerated defensively. */
    get(input: { sessionID: string }): Promise<unknown>;
  };
}

/**
 * Agent that owns the next prompt of a session. `session.get().agent` is optional in the schema:
 * when unset the session runs on the default agent, which is jevCode only when `makeDefault` is on
 * (the plugin then also calls `editor.default("jevCode")`). Returns `undefined` when unknown or on any
 * error - callers treat `undefined` as "not jev". Never throws.
 */
export async function resolveSessionAgent(
  ctx: SessionCtx,
  sessionID: string,
  options: Pick<Resolved, "makeDefault">,
): Promise<string | undefined> {
  try {
    const info = unwrapSession(await ctx.session.get({ sessionID }));
    const agent = info?.agent;
    if (typeof agent === "string" && agent !== "") return agent;
    return options.makeDefault ? JEV_AGENT_ID : undefined;
  } catch {
    return undefined;
  }
}

/** The host returns the SessionInfo directly; accept `{ data: SessionInfo }` as well. */
export function unwrapSession(response: unknown): { agent?: unknown; model?: unknown } | undefined {
  if (!response || typeof response !== "object") return undefined;
  const r = response as { data?: unknown; id?: unknown; agent?: unknown; model?: unknown };
  if (r.data && typeof r.data === "object" && !("id" in r) && !("agent" in r) && !("model" in r)) {
    return r.data as { agent?: unknown; model?: unknown };
  }
  return r;
}
