/**
 * Registers the jevCode agent inside the plugin (design D2, verified facts F1-F2) and verifies
 * the registration with a canary. Nothing here ever throws: a failed registration must never
 * make the plugin (or OpenCode) unusable.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Resolved } from "../config.ts";
import type { Logger } from "../log.ts";
import { applyJevAgent, JEV_AGENT_ID, renderAgentMarkdown, type AgentDraft } from "./definition.ts";

/** Structural subset of the host's `AgentEditor`. */
export interface AgentEditorLike {
  get(id: string): AgentDraft | undefined;
  update(id: string, update: (agent: AgentDraft) => void): void;
  default(id: string | undefined): void;
}

/** Structural subset of the host `Context` used here (real ctx and test fakes both fit). */
export interface AgentCtx {
  readonly agent: {
    transform(callback: (editor: AgentEditorLike) => void): Promise<{ dispose(): Promise<void> | void }>;
    /** Observed on 2.2.5: `{ location, data: AgentInfo[] }`. An array is tolerated too. */
    list(): Promise<unknown>;
  };
  readonly location: { readonly directory: string };
}

export interface RegisterDeps {
  options: Pick<Resolved, "makeDefault" | "agentFileFallback" | "agentModel">;
  log: Logger;
  /** Max wait for the canary's `agent.list()`; defaults to 5000 ms. */
  canaryTimeoutMs?: number;
}

export interface Disposable {
  dispose(): Promise<void> | void;
}

/** Location of the packaged copy, resolved relative to this module (works from source and from npm). */
export const PACKAGED_AGENT_FILE = fileURLToPath(new URL("../../agents/jevCode.md", import.meta.url));

export async function registerAgent(ctx: AgentCtx, deps: RegisterDeps): Promise<Disposable> {
  const { options, log } = deps;
  let registration: { dispose(): Promise<void> | void } | undefined;
  try {
    registration = await ctx.agent.transform((editor) => {
      // Synchronous and idempotent: transforms replay on every reload, and `update` upserts (F2).
      try {
        const build = editor.get("build");
        editor.update(JEV_AGENT_ID, (draft) => applyJevAgent(draft, options, build));
        if (options.makeDefault) editor.default(JEV_AGENT_ID);
      } catch (err) {
        log.error(`could not apply the ${JEV_AGENT_ID} agent definition:`, err);
      }
    });
  } catch (err) {
    log.error(`agent.transform failed; ${JEV_AGENT_ID} was not registered by the plugin:`, err);
  }

  await runCanary(ctx, deps);

  return {
    dispose: async () => {
      try {
        await registration?.dispose();
      } catch (err) {
        log.warn("agent registration cleanup failed:", err);
      }
    },
  };
}

export type CanaryResult = "present" | "missing" | "unknown";

/**
 * Checks that `ctx.agent.list()` contains jevCode. When it does not, logs an error with remediation
 * and (with `agentFileFallback`) writes the packaged agent file. Never throws.
 */
export async function runCanary(ctx: AgentCtx, deps: RegisterDeps): Promise<CanaryResult> {
  const { options, log } = deps;
  let present: boolean;
  try {
    present = hasAgent(await withTimeout(ctx.agent.list(), deps.canaryTimeoutMs ?? 5000), JEV_AGENT_ID);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    log.warn(`could not verify that the ${JEV_AGENT_ID} agent is registered (agent.list failed: ${why})`);
    return "unknown";
  }
  if (present) {
    log.debug(`canary: ${JEV_AGENT_ID} agent is registered`);
    return "present";
  }

  log.error(
    `canary: the ${JEV_AGENT_ID} agent is NOT in the agent list, so the in-plugin registration did not take effect ` +
      "(OpenCode may have changed AgentEditor.update). Copy agents/jevCode.md from the opencode-jevcode package " +
      "to .opencode/agents/jevCode.md, or set the plugin option agentFileFallback to true.",
  );
  if (options.agentFileFallback) {
    try {
      const written = await writeFallbackFile(ctx.location.directory);
      if (written.created) log.warn(`wrote fallback agent file ${written.path}; restart OpenCode to load it.`);
      else log.warn(`fallback agent file ${written.path} already exists; leaving it untouched.`);
    } catch (err) {
      log.error("could not write the fallback agent file:", err);
    }
  }
  return "missing";
}

/**
 * Writes the packaged agent file to `<directory>/.opencode/agents/jevCode.md` (creating folders).
 * Never overwrites an existing file. Throws only on unexpected I/O errors (callers guard it).
 */
export async function writeFallbackFile(directory: string): Promise<{ path: string; created: boolean }> {
  const dir = join(directory, ".opencode", "agents");
  const path = join(dir, `${JEV_AGENT_ID}.md`);
  await mkdir(dir, { recursive: true });
  const content = await readFile(PACKAGED_AGENT_FILE, "utf8").catch(() => renderAgentMarkdown());
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    return { path, created: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return { path, created: false };
    throw err;
  }
}

function hasAgent(response: unknown, id: string): boolean {
  const list = Array.isArray(response) ? response : (response as { data?: unknown } | null | undefined)?.data;
  if (!Array.isArray(list)) throw new Error("unexpected agent.list() response shape");
  return list.some((a) => (a as { id?: unknown } | null)?.id === id);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
