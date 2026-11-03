/**
 * Tool groups (story R4.1, design F7): tool ids -> logical groups via ID patterns.
 *
 * Patterns are case-insensitive globs (`*` = any run, `?` = one character) matched against the WHOLE tool id.
 * A tool that matches no pattern is "ungrouped": it is never excluded (R4.2, unknown group = keep).
 * The built-in groups can be extended by the `toolGroups` option; an unknown group name there creates a new group.
 */

export interface ToolGroup {
  name: string;
  patterns: string[];
  /** Short human text for the Jev question and the routing note. */
  description: string;
}

/** The built-in groups, in matching order (first match wins). `Other` has no built-in patterns. */
export const DEFAULT_TOOL_GROUPS: readonly ToolGroup[] = [
  { name: "Exploration", description: "reading and searching the codebase (read, grep, glob, list)", patterns: ["read", "grep", "glob", "list", "ls"] },
  { name: "Development", description: "changing files (edit, write, patch)", patterns: ["edit", "multiedit", "write", "patch", "apply_patch"] },
  { name: "Execution", description: "running shell commands and terminals", patterns: ["shell", "bash", "powershell", "terminal"] },
  { name: "Verification", description: "running tests and language-server diagnostics (test, lsp)", patterns: ["test", "lsp", "diagnostics"] },
  { name: "Research", description: "searching and fetching from the web (websearch, webfetch)", patterns: ["websearch", "webfetch", "codesearch"] },
  { name: "Delegation", description: "delegating work to subagents (subagent, task)", patterns: ["subagent", "task"] },
  {
    name: "Database",
    description: "querying or changing databases through MCP tools",
    patterns: ["*postgres*", "*mysql*", "*mariadb*", "*sqlite*", "*mongo*", "*database*", "*redis*"],
  },
  { name: "Other", description: "other tools configured by the user", patterns: [] },
];

/** Longest accepted pattern; longer ones are ignored. */
const MAX_PATTERN_LENGTH = 200;

const compiled = new Map<string, RegExp | null>();

/** Case-insensitive glob -> anchored RegExp (cached). `null` for an unusable pattern. */
function compile(pattern: string): RegExp | null {
  const cached = compiled.get(pattern);
  if (cached !== undefined) return cached;
  let re: RegExp | null = null;
  if (pattern !== "" && pattern.length <= MAX_PATTERN_LENGTH) {
    try {
      const source = pattern
        .replace(/\*+/g, "*")
        .split("")
        .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\/-]/g, "\\$&")))
        .join("");
      re = new RegExp(`^${source}$`, "i");
    } catch {
      re = null;
    }
  }
  if (compiled.size > 500) compiled.clear();
  compiled.set(pattern, re);
  return re;
}

/** True when `toolId` matches the glob `pattern` (whole id, case-insensitive). Never throws. */
export function matchesPattern(pattern: string, toolId: string): boolean {
  if (typeof pattern !== "string" || typeof toolId !== "string") return false;
  return compile(pattern)?.test(toolId) ?? false;
}

/** True when `toolId` matches any of `patterns`. */
export function matchesAny(patterns: readonly string[], toolId: string): boolean {
  return patterns.some((p) => matchesPattern(p, toolId));
}

/**
 * Built-in groups plus the user's extra patterns (appended, de-duplicated). Unknown names add new groups after the
 * built-in ones. Never throws; malformed input is ignored.
 */
export function resolveToolGroups(extra?: Record<string, string[]> | null): ToolGroup[] {
  const groups: ToolGroup[] = DEFAULT_TOOL_GROUPS.map((g) => ({ ...g, patterns: [...g.patterns] }));
  if (!extra || typeof extra !== "object") return groups;
  for (const [rawName, patterns] of Object.entries(extra)) {
    const name = rawName.trim();
    if (name === "" || !Array.isArray(patterns)) continue;
    const valid = patterns.filter((p): p is string => typeof p === "string" && p.trim() !== "").map((p) => p.trim());
    if (valid.length === 0) continue;
    let group = groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
    if (!group) {
      group = { name, patterns: [], description: `tools matching the configured patterns for "${name}"` };
      groups.push(group);
    }
    for (const p of valid) if (!group.patterns.includes(p)) group.patterns.push(p);
  }
  return groups;
}

/** Name of the first group whose patterns match `toolId`; `undefined` = ungrouped (never excluded). */
export function groupOf(toolId: string, groups: readonly ToolGroup[]): string | undefined {
  for (const g of groups) if (matchesAny(g.patterns, toolId)) return g.name;
  return undefined;
}

/** Groups that have at least one pattern (the ones worth asking Jev about). */
export function askableGroups(groups: readonly ToolGroup[]): ToolGroup[] {
  return groups.filter((g) => g.patterns.length > 0);
}
