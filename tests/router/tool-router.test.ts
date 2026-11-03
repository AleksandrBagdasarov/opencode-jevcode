import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Answers } from "../../src/jev/types.ts";
import { fallbackPlan } from "../../src/router/plan.ts";
import {
  askableGroups,
  DEFAULT_TOOL_GROUPS,
  groupOf,
  matchesPattern,
  resolveToolGroups,
} from "../../src/router/tool-groups.ts";
import { createToolRouter, decideTools, referencedTools, selectToolRemovals } from "../../src/router/tool-router.ts";
import { resolveOptions } from "../../src/config.ts";

const noul = (p: unknown) => ({ kind: "noul" as const, probability: p as number });
const log = { debug() {}, warn() {} };

describe("tool groups", () => {
  test("glob matching is whole-id and case-insensitive", () => {
    expect(matchesPattern("read", "read")).toBe(true);
    expect(matchesPattern("read", "READ")).toBe(true);
    expect(matchesPattern("read", "read_file")).toBe(false);
    expect(matchesPattern("*postgres*", "my_postgresql_query")).toBe(true);
    expect(matchesPattern("pg_?", "pg_a")).toBe(true);
    expect(matchesPattern("pg_?", "pg_ab")).toBe(false);
    expect(matchesPattern("a.b", "axb")).toBe(false);
    expect(matchesPattern("", "x")).toBe(false);
    expect(matchesPattern("x".repeat(500), "x")).toBe(false);
    expect(matchesPattern(5 as unknown as string, "x")).toBe(false);
  });

  test("built-in groups map the documented tools", () => {
    const g = resolveToolGroups();
    expect(groupOf("read", g)).toBe("Exploration");
    expect(groupOf("grep", g)).toBe("Exploration");
    expect(groupOf("glob", g)).toBe("Exploration");
    expect(groupOf("list", g)).toBe("Exploration");
    expect(groupOf("edit", g)).toBe("Development");
    expect(groupOf("write", g)).toBe("Development");
    expect(groupOf("patch", g)).toBe("Development");
    expect(groupOf("shell", g)).toBe("Execution");
    expect(groupOf("terminal", g)).toBe("Execution");
    expect(groupOf("test", g)).toBe("Verification");
    expect(groupOf("lsp", g)).toBe("Verification");
    expect(groupOf("websearch", g)).toBe("Research");
    expect(groupOf("webfetch", g)).toBe("Research");
    expect(groupOf("subagent", g)).toBe("Delegation");
    expect(groupOf("task", g)).toBe("Delegation");
    expect(groupOf("postgresql_query", g)).toBe("Database");
  });

  test("tools matching no pattern are ungrouped", () => {
    const g = resolveToolGroups();
    expect(groupOf("todowrite", g)).toBeUndefined();
    expect(groupOf("question", g)).toBeUndefined();
    expect(groupOf("github_create_issue", g)).toBeUndefined();
  });

  test("user patterns extend a built-in group and can create new groups; defaults are kept", () => {
    const g = resolveToolGroups({ Database: ["*supabase*"], Other: ["todowrite"], Docs: ["notion_*"], "  ": ["x"], Empty: [] });
    expect(groupOf("supabase_sql", g)).toBe("Database");
    expect(groupOf("postgres_x", g)).toBe("Database");
    expect(groupOf("todowrite", g)).toBe("Other");
    expect(groupOf("notion_search", g)).toBe("Docs");
    expect(g.map((x) => x.name)).toEqual([...DEFAULT_TOOL_GROUPS.map((x) => x.name), "Docs"]);
    // case-insensitive group name merge, no duplicate patterns
    const again = resolveToolGroups({ database: ["*mysql*", "*supabase*"] });
    expect(again.find((x) => x.name === "Database")!.patterns.filter((p) => p === "*mysql*")).toHaveLength(1);
    // the shared default list is not mutated
    expect(DEFAULT_TOOL_GROUPS.find((x) => x.name === "Database")!.patterns).not.toContain("*supabase*");
  });

  test("hostile extension input is ignored", () => {
    expect(() => resolveToolGroups({ A: "x" as unknown as string[], B: [1, null, ""] as unknown as string[] })).not.toThrow();
    expect(resolveToolGroups(null)).toHaveLength(DEFAULT_TOOL_GROUPS.length);
  });

  test("only groups with patterns are asked about (Other is empty by default)", () => {
    const names = askableGroups(resolveToolGroups()).map((g) => g.name);
    expect(names).not.toContain("Other");
    expect(names).toContain("Exploration");
    expect(askableGroups(resolveToolGroups({ Other: ["x"] })).map((g) => g.name)).toContain("Other");
  });

  test("option parsing: toolGroups", () => {
    expect(resolveOptions(undefined, {}).toolGroups).toEqual({});
    expect(resolveOptions({ toolGroups: "x" }, {}).toolGroups).toEqual({});
    expect(resolveOptions({ toolGroups: [1] }, {}).toolGroups).toEqual({});
    expect(resolveOptions({ toolGroups: { Database: [" *x* ", "*x*", 3, ""], " ": ["a"], Empty: [], __proto__: ["a"] } }, {}).toolGroups).toEqual({
      Database: ["*x*"],
    });
  });
});

describe("decideTools", () => {
  const asked = ["Exploration", "Development", "Execution"];
  test("below the threshold excludes, at/above keeps", () => {
    const answers: Answers = {
      "tools:Exploration": noul(0.9),
      "tools:Development": noul(0.39),
      "tools:Execution": noul(0.4),
    };
    expect(decideTools(answers, asked, 0.4)).toEqual({ groups: ["Exploration", "Execution"], excluded: ["Development"], answered: 3 });
  });

  test("probabilities are clamped; NaN, wrong kind, missing and extra keys keep the group / are ignored", () => {
    const answers = {
      "tools:Exploration": noul(5),
      "tools:Development": noul(-3),
      "tools:Execution": noul(Number.NaN),
      "tools:Unknown": noul(0),
      model: { kind: "choice", choice: "x", confidence: 1, probabilities: {} },
    } as unknown as Answers;
    const d = decideTools(answers, asked, 0.4);
    expect(d.excluded).toEqual(["Development"]);
    expect(d.groups).toEqual(["Exploration", "Execution"]);
    expect(d.answered).toBe(2);
  });

  test("null answers keep everything", () => {
    expect(decideTools(null, asked, 0.4)).toEqual({ groups: asked, excluded: [], answered: 0 });
    expect(decideTools({ "tools:Exploration": { kind: "error", reason: "x" } }, asked, 0.4).answered).toBe(0);
  });
});

describe("tool router contributor", () => {
  const router = () => createToolRouter({ options: { toolThreshold: 0.4, toolGroups: {} }, log });

  test("one noul per group with patterns, names tools:<group>", async () => {
    const prepared = await router().prepare({} as never);
    if ("skip" in prepared) throw new Error("unexpected skip");
    const names = Object.keys(prepared.questions);
    expect(names).toContain("tools:Exploration");
    expect(names).toContain("tools:Database");
    expect(names).not.toContain("tools:Other");
    for (const q of Object.values(prepared.questions)) expect(q.kind).toBe("noul");
  });

  test("apply fills plan.tools and reports decided only with a usable answer", async () => {
    const prepared = await router().prepare({} as never);
    if ("skip" in prepared) throw new Error("unexpected skip");
    const plan = fallbackPlan("s", "t", "x");
    const out = await prepared.apply({ "tools:Exploration": noul(0.9), "tools:Execution": noul(0.1) }, plan);
    expect(out.decided).toBe(true);
    expect(plan.tools.excluded).toEqual(["Execution"]);
    expect(plan.tools.groups).toContain("Exploration");
    expect(plan.tools.groups).toContain("Development"); // unanswered => kept

    const p2 = fallbackPlan("s", "t", "x");
    expect((await prepared.apply(null, p2)).decided).toBe(false);
    expect((await prepared.apply({}, p2)).decided).toBe(false);
    expect(p2.tools).toEqual({ groups: [], excluded: [] });
  });

  test("user group patterns add questions", async () => {
    const r = createToolRouter({ options: { toolThreshold: 0.4, toolGroups: { Docs: ["notion_*"] } }, log });
    const prepared = await r.prepare({} as never);
    if ("skip" in prepared) throw new Error("unexpected skip");
    expect(Object.keys(prepared.questions)).toContain("tools:Docs");
  });
});

describe("referencedTools", () => {
  test("collects names of tool-call and tool-result parts, with namespace spellings", () => {
    const refs = referencedTools([
      { role: "assistant", content: [{ type: "tool-call", id: "1", name: "grep", input: {} }, { type: "text", text: "grep2" }] },
      { role: "tool", content: [{ type: "tool-result", id: "1", name: "grep", result: { type: "text", value: "" } }] },
      { role: "assistant", content: [{ type: "tool-call", id: "2", name: "query", namespace: "pg", input: {} }] },
    ]);
    expect(refs.has("grep")).toBe(true);
    expect(refs.has("grep2")).toBe(false);
    expect(refs.has("query")).toBe(true);
    expect(refs.has("pg_query")).toBe(true);
    expect(refs.has("pg/query")).toBe(true);
  });

  test("tolerates garbage", () => {
    expect(referencedTools(undefined).size).toBe(0);
    expect(referencedTools([null, 1, { content: "x" }, { content: [null, { type: "tool-call" }, { type: "tool-call", name: 3 }] }]).size).toBe(0);
  });
});

describe("selectToolRemovals", () => {
  const groups = resolveToolGroups();
  const base = {
    toolIds: ["read", "grep", "edit", "write", "shell", "todowrite", "postgres_query"],
    groups,
    alwaysKeep: [] as string[],
    referenced: new Set<string>(),
  };

  test("removes tools of excluded groups only; ungrouped tools stay", () => {
    expect(selectToolRemovals({ ...base, excludedGroups: ["Development", "Execution"] })).toEqual(["edit", "write", "shell"]);
    expect(selectToolRemovals({ ...base, excludedGroups: ["Database"] })).toEqual(["postgres_query"]);
    expect(selectToolRemovals({ ...base, excludedGroups: [] })).toEqual([]);
    expect(selectToolRemovals({ ...base, excludedGroups: ["Nope"] })).toEqual([]);
  });

  test("alwaysKeepTools (exact or glob) and referenced tools are kept", () => {
    const r = selectToolRemovals({
      ...base,
      excludedGroups: ["Development", "Execution"],
      alwaysKeep: ["edit", "SH*"],
      referenced: new Set(["write"]),
    });
    expect(r).toEqual([]);
  });

  test("never removes every tool", () => {
    expect(selectToolRemovals({ ...base, toolIds: ["edit", "write"], excludedGroups: ["Development"] })).toEqual([]);
    expect(selectToolRemovals({ ...base, toolIds: ["edit", "write", "todowrite"], excludedGroups: ["Development"] })).toEqual(["edit", "write"]);
    expect(selectToolRemovals({ ...base, toolIds: [], excludedGroups: ["Development"] })).toEqual([]);
  });
});

describe("no permission API in the tool routing path (R4.4)", () => {
  test("source files never mention permissions", () => {
    for (const f of ["src/router/tool-groups.ts", "src/router/tool-router.ts", "src/opencode/context-hook.ts"]) {
      const text = readFileSync(resolve(import.meta.dir, "..", "..", f), "utf8");
      expect(/permission/i.test(text)).toBe(false);
    }
  });
});
