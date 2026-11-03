import { describe, expect, test } from "bun:test";
import type { Answers, Questions } from "../../src/jev/types.ts";
import {
  buildRoutingNote,
  createContextHook,
  latestUserKeys,
  ROUTING_NOTE_MARKER,
  ROUTING_NOTE_MAX_CHARS,
  type ContextEvent,
} from "../../src/opencode/context-hook.ts";
import { createPromptHook } from "../../src/opencode/prompt-hook.ts";
import { fallbackPlan, hashText, type TurnPlan } from "../../src/router/plan.ts";
import { createToolRouter } from "../../src/router/tool-router.ts";
import { createPlanCache, createRestoreMemory, type PlanCache, type StorageLike } from "../../src/state/session-state.ts";

const log = { debug() {}, info() {}, warn() {} };
const ALL_TOOLS = ["read", "grep", "glob", "edit", "write", "shell", "websearch", "subagent", "todowrite", "postgres_query"];

const toolsRecord = (ids: readonly string[] = ALL_TOOLS) =>
  Object.fromEntries(ids.map((id) => [id, { description: `${id} tool`, input: { type: "object" } }]));

const user = (id: string | undefined, text: string) => ({ ...(id ? { id } : {}), role: "user", content: [{ type: "text", text }] });

function plan(over: Partial<TurnPlan> = {}): TurnPlan {
  return {
    ...fallbackPlan("s1", "u1", "x"),
    source: "jev",
    fallbackReason: undefined,
    tools: { groups: ["Exploration"], excluded: ["Development", "Execution", "Research", "Delegation", "Database"] },
    ...over,
  };
}

function setup(opts: { plan?: TurnPlan; alwaysKeepTools?: string[]; toolGroups?: Record<string, string[]> } = {}) {
  const plans = createPlanCache<TurnPlan>();
  if (opts.plan) plans.set(opts.plan);
  const hook = createContextHook({
    options: { alwaysKeepTools: opts.alwaysKeepTools ?? [], toolGroups: opts.toolGroups ?? {} },
    log,
    plans,
  });
  return { plans, hook };
}

function event(over: Partial<ContextEvent> = {}): ContextEvent {
  return {
    sessionID: "s1",
    agent: "jevCode",
    system: [{ type: "text", text: "You are jevCode." }, { type: "text", text: "Project rules." }],
    messages: [user("u1", "fix the bug")],
    tools: toolsRecord(),
    ...over,
  };
}

const keys = (e: ContextEvent) => Object.keys(e.tools as object);

describe("tool filtering", () => {
  test("tools of excluded groups are removed; ungrouped tools and kept groups stay", async () => {
    const { hook } = setup({ plan: plan() });
    const e = event();
    await hook(e);
    expect(keys(e)).toEqual(["read", "grep", "glob", "todowrite"]);
  });

  test("alwaysKeepTools (exact and glob) are never removed", async () => {
    const { hook } = setup({ plan: plan(), alwaysKeepTools: ["shell", "Web*"] });
    const e = event();
    await hook(e);
    expect(keys(e)).toEqual(["read", "grep", "glob", "shell", "websearch", "todowrite"]);
  });

  test("tools referenced by tool-call / tool-result parts of the request are never removed", async () => {
    const { hook } = setup({ plan: plan() });
    const e = event({
      messages: [
        user("u0", "earlier"),
        { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "edit", input: {} }] },
        { role: "tool", content: [{ type: "tool-result", id: "c1", name: "edit", result: { type: "text", value: "ok" } }] },
        { role: "assistant", content: [{ type: "tool-result", id: "c2", name: "shell", result: { type: "text", value: "ok" } }] },
        user("u1", "fix the bug"),
      ],
    });
    await hook(e);
    expect(keys(e)).toEqual(["read", "grep", "glob", "edit", "shell", "todowrite"]);
  });

  test("a tool only referenced by a message a stage pruned away is removable again", async () => {
    const plans = createPlanCache<TurnPlan>();
    plans.set(plan());
    const hook = createContextHook({
      options: { alwaysKeepTools: [], toolGroups: {} },
      log,
      plans,
      stages: [
        {
          name: "prune",
          apply(ev) {
            ev.messages = (ev.messages as unknown[]).filter((m: any) => m.role === "user");
          },
        },
      ],
    });
    const e = event({ messages: [{ role: "assistant", content: [{ type: "tool-call", id: "c", name: "edit", input: {} }] }, user("u1", "x")] });
    await hook(e);
    expect(keys(e)).not.toContain("edit");
  });

  test("a failing stage is isolated: filtering and note still happen", async () => {
    const plans = createPlanCache<TurnPlan>();
    plans.set(plan());
    const hook = createContextHook({
      options: { alwaysKeepTools: [], toolGroups: {} },
      log,
      plans,
      stages: [{ name: "boom", apply: () => Promise.reject(new Error("x")) }],
    });
    const e = event();
    await hook(e);
    expect(keys(e)).toEqual(["read", "grep", "glob", "todowrite"]);
    expect((e.system as unknown[]).length).toBe(3);
  });

  test("user-defined groups take part in exclusion", async () => {
    const { hook } = setup({
      plan: plan({ tools: { groups: ["Exploration"], excluded: ["Docs"] } }),
      toolGroups: { Docs: ["notion_*"] },
    });
    const e = event({ tools: toolsRecord(["read", "notion_search", "notion_page"]) });
    await hook(e);
    expect(keys(e)).toEqual(["read"]);
  });

  test("if the exclusion would remove every tool, event.tools is unchanged", async () => {
    const { hook } = setup({ plan: plan() });
    const e = event({ tools: toolsRecord(["edit", "write", "shell"]) });
    const before = structuredClone(e.tools);
    await hook(e);
    expect(e.tools).toEqual(before);
    const note = ((e.system as any[])[2] as { text: string }).text;
    expect(note.startsWith(ROUTING_NOTE_MARKER)).toBe(true);
    expect(note).not.toContain("left out");
  });

  test("no tools object / empty tools do not break the hook", async () => {
    const { hook } = setup({ plan: plan() });
    for (const tools of [undefined, null, [], {}, "x"]) {
      const e = event({ tools });
      await hook(e);
      expect(e.tools).toEqual(tools as never);
    }
  });
});

describe("isolation: other agents are never touched", () => {
  test("agent build: event deep-equal before/after, plan cache never consulted", async () => {
    let touched = 0;
    const plans = createPlanCache<TurnPlan>();
    plans.set(plan());
    const spy: PlanCache<TurnPlan> = {
      set: plans.set,
      get: (s) => (touched++, plans.get(s)),
      getForTurn: (s, k) => (touched++, plans.getForTurn(s, k)),
      delete: plans.delete,
      size: plans.size,
    };
    const hook = createContextHook({ options: { alwaysKeepTools: [], toolGroups: {} }, log, plans: spy });
    for (const agent of ["build", "plan", "jevcode", "jevCode2", " jevCode", undefined]) {
      const e = event({ agent });
      const before = structuredClone(e);
      await hook(e);
      expect(e).toEqual(before);
    }
    expect(touched).toBe(0);
  });

  test("hostile events never throw", async () => {
    const { hook } = setup({ plan: plan() });
    for (const e of [undefined, null, {}, { agent: "jevCode" }, event({ system: "text" as never }), event({ messages: "x" as never }), event({ sessionID: 5 as never })]) {
      await hook(e as ContextEvent);
    }
    const throwing: PlanCache<TurnPlan> = {
      set() {},
      get() {
        throw new Error("x");
      },
      getForTurn() {
        throw new Error("x");
      },
      delete() {},
      size: () => 0,
    };
    const h = createContextHook({ options: { alwaysKeepTools: [], toolGroups: {} }, log, plans: throwing });
    const e = event();
    const before = structuredClone(e);
    await h(e);
    expect(e).toEqual(before);
  });
});

describe("turn plan validation and continuations", () => {
  function storage(): StorageLike {
    const data = new Map<string, unknown>();
    return {
      get: async (k) => (data.has(k) ? structuredClone(data.get(k)) : undefined),
      set: async (k, v) => void data.set(k, structuredClone(v)),
      remove: async (k) => void data.delete(k),
    };
  }

  /** Prompt hook (stage A, tool router only) with a counting stub client, sharing the plan cache with the context hook. */
  function pipeline(answer: (q: Questions) => Answers | null) {
    const plans = createPlanCache<TurnPlan>();
    let asks = 0;
    const options = { alwaysKeepTools: [] as string[], toolGroups: {}, toolThreshold: 0.4, makeDefault: false };
    const prompt = createPromptHook({
      ctx: {
        session: {
          get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, agent: "jevCode", model: { providerID: "mock", id: "m" } }),
          switchModel: async () => {},
        },
      },
      options,
      log,
      client: {
        ask: async (_s: unknown, q: Questions) => {
          asks++;
          return answer(q);
        },
      },
      memory: createRestoreMemory(storage(), log),
      plans,
      contributors: [createToolRouter({ options, log })],
    });
    const context = createContextHook({ options, log, plans });
    return { prompt, context, plans, asks: () => asks };
  }

  const onlyExploration = (q: Questions): Answers =>
    Object.fromEntries(Object.keys(q).map((k) => [k, { kind: "noul" as const, probability: k === "tools:Exploration" ? 0.9 : 0.05 }]));

  test("continuations (same turnKey) make zero Jev calls and re-apply the same filtering", async () => {
    const p = pipeline(onlyExploration);
    await p.prompt({ sessionID: "s1", messageID: "u1", prompt: { text: "fix the bug" } });
    expect(p.asks()).toBe(1);
    const results: string[][] = [];
    for (let i = 0; i < 4; i++) {
      const e = event({
        messages: [user("u1", "fix the bug"), ...(i > 0 ? [{ role: "assistant", content: [{ type: "tool-call", id: `c${i}`, name: "read", input: {} }] }] : [])],
      });
      await p.context(e);
      results.push(keys(e));
    }
    expect(p.asks()).toBe(1);
    for (const r of results) expect(r).toEqual(["read", "grep", "glob", "todowrite"]);
  });

  test("a new user message (new turnKey) without a new plan falls back: all tools, minimal note", async () => {
    const p = pipeline(onlyExploration);
    await p.prompt({ sessionID: "s1", messageID: "u1", prompt: { text: "fix the bug" } });
    const e = event({ messages: [user("u1", "fix the bug"), { role: "assistant", content: [{ type: "text", text: "ok" }] }, user("u2", "now something else")] });
    const before = structuredClone(e.tools);
    await p.context(e);
    expect(e.tools).toEqual(before);
    const parts = e.system as Array<{ text: string }>;
    expect(parts).toHaveLength(3);
    expect(parts[2]!.text).toBe(buildRoutingNote(fallbackPlan("s1", "u2", "x")));
    expect(p.asks()).toBe(1);
  });

  test("missing plan (no prompt hook ran) falls back the same way", async () => {
    const { hook } = setup();
    const e = event();
    const before = structuredClone(e.tools);
    await hook(e);
    expect(e.tools).toEqual(before);
    expect((e.system as Array<{ text: string }>)[2]!.text).toContain("all tools are available");
  });

  test("the plan of another session is not used", async () => {
    const { hook } = setup({ plan: plan() });
    const e = event({ sessionID: "other" });
    const before = structuredClone(e.tools);
    await hook(e);
    expect(e.tools).toEqual(before);
  });

  test("when the host gave no message id the text-hash key still matches the plan", async () => {
    const p = pipeline(onlyExploration);
    await p.prompt({ sessionID: "s1", prompt: { text: "fix the bug" } });
    expect(p.plans.get("s1")!.turnKey).toBe(`h:${hashText("fix the bug")}:11`);
    const e = event({ messages: [user(undefined, "fix the bug")] });
    await p.context(e);
    expect(keys(e)).toEqual(["read", "grep", "glob", "todowrite"]);
  });

  test("a fallback plan from Jev failure keeps every tool", async () => {
    const p = pipeline(() => null);
    await p.prompt({ sessionID: "s1", messageID: "u1", prompt: { text: "fix the bug" } });
    expect(p.plans.get("s1")!.source).toBe("fallback");
    const e = event();
    const before = structuredClone(e.tools);
    await p.context(e);
    expect(e.tools).toEqual(before);
  });

  test("latestUserKeys: id first, text hash second, from the LAST user message", () => {
    expect(latestUserKeys([user("a", "x"), user("b", "yy")])).toEqual(["b", `h:${hashText("yy")}:2`]);
    expect(latestUserKeys([user(undefined, "yy")])).toEqual([`h:${hashText("yy")}:2`]);
    expect(latestUserKeys([{ role: "user", id: "k", content: "plain" }])).toEqual(["k", `h:${hashText("plain")}:5`]);
    expect(latestUserKeys([{ role: "assistant", content: [] }])).toEqual([]);
    expect(latestUserKeys(undefined)).toEqual([]);
  });
});

describe("routing note", () => {
  test("appended as a new part; existing parts are untouched; not appended twice", async () => {
    const { hook } = setup({ plan: plan({ skills: ["db-migrations"], tools: { groups: ["Exploration", "Development"], excluded: ["Execution"] } }) });
    const e = event();
    const original = structuredClone(e.system as unknown[]);
    await hook(e);
    const parts = e.system as Array<{ type: string; text: string }>;
    expect(parts).toHaveLength(3);
    expect(parts.slice(0, 2)).toEqual(original as never);
    expect(parts[2]!.type).toBe("text");
    expect(parts[2]!.text).toBe(
      "[jevCode routing] Skills selected for this request: db-migrations. Tool groups available: Exploration, Development. Not needed for this request and left out: Execution.",
    );
    await hook(e); // same system array again (re-entrance)
    expect(parts).toHaveLength(3);
  });

  test("note lists only groups that really lost tools as left out", () => {
    const p = plan({ tools: { groups: ["Exploration"], excluded: ["Database", "Execution"] } });
    expect(buildRoutingNote(p, ["Execution"])).toContain("left out: Execution.");
    expect(buildRoutingNote(p, ["Execution"])).not.toContain("Database");
    expect(buildRoutingNote(p, [])).not.toContain("left out");
  });

  test("note is never longer than 600 chars", () => {
    const many = Array.from({ length: 50 }, (_, i) => `group-number-${i}`);
    const long = plan({ skills: ["s".repeat(300), "t".repeat(300), "u".repeat(300)], tools: { groups: many, excluded: many } });
    const note = buildRoutingNote(long, many);
    expect(note.length).toBeLessThanOrEqual(ROUTING_NOTE_MAX_CHARS);
    expect(note.startsWith(ROUTING_NOTE_MARKER)).toBe(true);
  });

  test("a jev plan with nothing special still gets a short note; fallback gets the minimal one", () => {
    expect(buildRoutingNote(plan({ tools: { groups: [], excluded: [] } }))).toBe("[jevCode routing] All tools are available.");
    expect(buildRoutingNote(fallbackPlan("s", "t", "x"))).toBe("[jevCode routing] No routing plan for this request; all tools are available.");
  });
});
