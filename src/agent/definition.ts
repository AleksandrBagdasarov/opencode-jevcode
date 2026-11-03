/**
 * The jevCode agent definition (story R1, design D2). Single source of truth for the system prompt:
 * agents/jevCode.md is rendered from the same constants (a test pins the equality).
 */
import type { Resolved } from "../config.ts";

export const JEV_AGENT_ID = "jevCode";

export const JEV_DESCRIPTION = "Jev-powered coding agent with dynamic model and context routing";

export const JEV_COLOR = "#8B5CF6";

export const JEV_SYSTEM_PROMPT =
  "You are jevCode, a coding agent controlled by a frontier decision router. " +
  "Follow the model, context, skills and tool configuration provided for each request. " +
  "Do not assume that tools or skills unavailable in the current request are available.";

/** Model reference as stored on an agent (`provider/id[#variant]` in options). */
export interface AgentModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/** Parse `provider/id[#variant]`. The id may itself contain `/` (only the first one splits). */
export function parseModelKey(key: string | undefined): AgentModelRef | undefined {
  if (typeof key !== "string") return undefined;
  const slash = key.indexOf("/");
  if (slash <= 0) return undefined;
  const providerID = key.slice(0, slash);
  let id = key.slice(slash + 1);
  let variant: string | undefined;
  const hash = id.lastIndexOf("#");
  if (hash >= 0) {
    variant = id.slice(hash + 1) || undefined;
    id = id.slice(0, hash);
  }
  if (!id) return undefined;
  return variant ? { providerID, id, variant } : { providerID, id };
}

/** Structural subset of the host's mutable `Agent.Info` that this plugin touches. */
export interface AgentDraft {
  description?: string;
  mode?: "subagent" | "primary" | "all";
  system?: string;
  color?: string;
  model?: AgentModelRef;
  permissions?: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>;
}

/**
 * Apply the jevCode definition to an agent draft. Idempotent: it only assigns (never appends), so
 * running it N times leaves the draft identical to running it once. `build` (when given) supplies a
 * deep copy of the permissions: the plugin never invents or widens permissions (R1.2). Without
 * `build` the host's default permissions for the new agent are left untouched.
 */
export function applyJevAgent(
  draft: AgentDraft,
  options: Pick<Resolved, "agentModel">,
  build?: Pick<AgentDraft, "permissions">,
): void {
  draft.description = JEV_DESCRIPTION;
  draft.mode = "primary";
  draft.system = JEV_SYSTEM_PROMPT;
  draft.color = JEV_COLOR;
  const model = parseModelKey(options.agentModel);
  if (model) draft.model = model;
  if (build?.permissions) draft.permissions = build.permissions.map((rule) => ({ ...rule }));
}

/** Content of the packaged `agents/jevCode.md` (frontmatter + system prompt as body). */
export function renderAgentMarkdown(): string {
  return [
    "---",
    `description: ${JEV_DESCRIPTION}`,
    "mode: primary",
    `color: "${JEV_COLOR}"`,
    "---",
    "",
    JEV_SYSTEM_PROMPT,
    "",
  ].join("\n");
}
