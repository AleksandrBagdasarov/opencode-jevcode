import { describe, expect, test } from "bun:test";
import { findOrphans } from "../../src/context/message-groups.ts";
import type { Answers, Questions } from "../../src/jev/types.ts";
import { createContextHook, type ContextEvent } from "../../src/opencode/context-hook.ts";
import {
  CONTEXT_MAX_QUESTIONS,
  createContextRouter,
  createContextWindowLookup,
  questionGroups,
  type ContextRouterDeps,
} from "../../src/router/context-router.ts";
import { fallbackPlan, type TurnPlan } from "../../src/router/plan.ts";
import { createPlanCache } from "../../src/state/session-state.ts";
import { assistantText, callPart, deepFreeze, resultPart, userMsg } from "../context/gen.ts";

const log = { debug() {}, warn() {} };

/** user u<i> + assistant tool call + big tool result + assistant text per turn. */
function convo(turns: number, body = 2000): any[] {
  const out: any[] = [];
  for (let i = 0; i < turns; i++) {
    out.push(userMsg(`u${i}`, `request ${i} about src/file${i}.ts`));
    out.push({ id: `a${i}`, role: "assistant", content: [callPart(`c${i}`, i % 2 ? "edit" : "read", { filePath: `src/file${i}.ts` })] });
    out.push({ id: `t${i}`, role: "tool", content: [resultPart(`c${i}`, i % 2 ? "edit" : "read", "b".repeat(body))] });
    out.push(assistantText(`done ${i}`, `r${i}`));
  }
  return out;
}

const jevPlan = (): TurnPlan => ({ ...fallbackPlan("s1", "u7", "x"), source: "jev", fallbackReason: undefined });

type Scorer = (unit: string) => { score: number; confidence?: number } | undefined;

function stub(scorer: Scorer) {
  const asks: Array<{ state: any; questions: Questions }> = [];
  return {
    asks,
    client: {
      async ask(state: unknown, questions: Questions): Promise<Answers | null> {
        asks.push({ state, questions });
        const answers: Answers = {};
        for (const name of Object.keys(questions)) {
          const s = scorer(name.slice("unit:".length));
          if (s) answers[name] = { kind: "score", score: s.score, confidence: s.confidence ?? 0.9 };
        }
        return answers;
      },
    },
  };
}

function router(client: ContextRouterDeps["client"], over: Partial<ContextRouterDeps> = {}) {
  return createContextRouter({
    options: { keepRecentMessages: 2, keepFirstUser: true, pruneMinTokens: 1000, contextMinConfidence: 0.5 },
    log,
    client,
    ...over,
  });
}

const ev = (messages: unknown, extra: Partial<ContextEvent> = {}): ContextEvent => ({ sessionID: "s1", agent: "jevCode", messages, system: [], tools: {}, ...extra });
const ids = (e: ContextEvent) => (e.messages as any[]).map((m) => m.id ?? "-");

describe("when pruning runs", () => {
  test("conversations below pruneMinTokens: zero Jev calls and the messages are not modified", async () => {
    const { client, asks } = stub(() => ({ score: 0 }));
    const messages = deepFreeze(convo(3, 10));
    const e = ev(messages);
    await router(client, { options: { keepRecentMessages: 2, keepFirstUser: true, pruneMinTokens: 100_000, contextMinConfidence: 0.5 } }).apply(e, jevPlan());
    expect(asks).toHaveLength(0);
    expect(e.messages).toBe(messages);
  });

  test("a plan that is not from Jev (fallback / stale) is never pruned and never asks", async () => {
    const { client, asks } = stub(() => ({ score: 0 }));
    const e = ev(convo(8));
    const original = e.messages;
    await router(client).apply(e, { ...jevPlan(), source: "fallback" });
    expect(asks).toHaveLength(0);
    expect(e.messages).toBe(original);
  });

  test("hostile events: no messages, no user message, non-array", async () => {
    const { client, asks } = stub(() => ({ score: 0 }));
    const r = router(client);
    for (const messages of [undefined, null, "x", [], [assistantText("no user")], [{ role: "user" }]]) {
      const e = ev(messages);
      await r.apply(e, jevPlan());
      expect(e.messages).toBe(messages as any);
    }
    expect(asks).toHaveLength(0);
  });
});

describe("first model call of a turn", () => {
  test("ONE request: score questions only for non-forced units; low scores are dropped as whole units (pairs intact)", async () => {
    // units: u0 (first user, forced) .. u7 (latest, forced); u6 = last 2 messages... keepRecent=2 forces only u7's tail
    const { client, asks } = stub((id) => ({ score: ["u1", "u3", "u5"].includes(id) ? 0 : 4 }));
    const messages = deepFreeze(convo(8));
    const e = ev(messages);
    const plan = jevPlan();
    await router(client).apply(e, plan);

    expect(asks).toHaveLength(1);
    const names = Object.keys(asks[0]!.questions);
    expect(names.sort()).toEqual(["unit:u1", "unit:u2", "unit:u3", "unit:u4", "unit:u5", "unit:u6"]); // u0 and u7 are forced
    for (const q of Object.values(asks[0]!.questions)) expect(q.kind).toBe("score");
    // the state carries the compact summary, not bodies
    expect(JSON.stringify(asks[0]!.state)).not.toContain("b".repeat(300));
    expect(asks[0]!.state.contextCandidates.map((c: any) => c.id)).toContain("u3");

    // u1, u3, u5 are gone (4 messages each), nothing else
    expect(e.messages).not.toBe(messages);
    expect((e.messages as any[]).length).toBe(messages.length - 12);
    expect(ids(e)).not.toContain("u1");
    expect(ids(e)).not.toContain("t3");
    expect(ids(e)).toContain("u0");
    expect(ids(e)).toContain("u7");
    expect(findOrphans(e.messages as unknown[])).toEqual([]);
    expect(plan.context?.droppedUnitIds).toEqual(["u1", "u3", "u5"]);
    expect(plan.context?.keepUnitIds).toContain("u0");
    expect(plan.context?.confidence).toBeCloseTo(0.9);
  });

  test("continuations make zero Jev calls, re-apply the cached drops and keep messages appended during the turn", async () => {
    const { client, asks } = stub((id) => ({ score: ["u1", "u3"].includes(id) ? 0 : 4 }));
    const r = router(client);
    const plan = jevPlan();
    const base = convo(8);
    const first = ev(base);
    await r.apply(first, plan);
    expect(asks).toHaveLength(1);

    const appended = [
      { id: "a-new", role: "assistant", content: [callPart("c-new", "shell", { command: "ls" })] },
      { id: "t-new", role: "tool", content: [resultPart("c-new", "shell", "files")] },
    ];
    const second = ev(deepFreeze([...base, ...appended]));
    await r.apply(second, plan);
    expect(asks).toHaveLength(1); // no new request
    expect(ids(second)).not.toContain("u1");
    expect(ids(second)).not.toContain("u3");
    expect(ids(second).slice(-2)).toEqual(["a-new", "t-new"]);
    expect(second.messages).toHaveLength((first.messages as any[]).length + 2);
    expect(findOrphans(second.messages as unknown[])).toEqual([]);
  });

  test("a no-op first decision is remembered too: a conversation that grows over pruneMinTokens during the turn does not ask on continuations", async () => {
    const { client, asks } = stub(() => ({ score: 0 }));
    const r = router(client, { options: { keepRecentMessages: 2, keepFirstUser: true, pruneMinTokens: 3000, contextMinConfidence: 0.5 } });
    const plan = jevPlan();
    await r.apply(ev(convo(1, 50)), plan); // small: nothing asked
    await r.apply(ev(convo(8)), plan); // grew, but this is a continuation of the same turn
    expect(asks).toHaveLength(0);
  });

  test("simultaneous first calls share ONE request", async () => {
    const { client, asks } = stub((id) => ({ score: id === "u2" ? 0 : 4 }));
    const r = router(client);
    const plan = jevPlan();
    const [a, b] = [ev(convo(8)), ev(convo(8))];
    await Promise.all([r.apply(a, plan), r.apply(b, plan)]);
    expect(asks).toHaveLength(1);
    expect(ids(a)).not.toContain("u2");
    expect(ids(b)).not.toContain("u2");
  });

  test("a new turn (new plan) asks again", async () => {
    const { client, asks } = stub(() => ({ score: 4 }));
    const r = router(client);
    await r.apply(ev(convo(8)), jevPlan());
    await r.apply(ev(convo(8)), jevPlan());
    expect(asks).toHaveLength(2);
  });
});

describe("fail open", () => {
  const original = () => deepFreeze(convo(8));

  test("Jev unavailable (null) -> original messages", async () => {
    const e = ev(original());
    const before = e.messages;
    await router({ ask: async () => null }).apply(e, jevPlan());
    expect(e.messages).toBe(before);
  });

  test("the client throws -> original messages, no exception", async () => {
    const e = ev(original());
    const before = e.messages;
    await expect(router({ ask: async () => Promise.reject(new Error("boom")) }).apply(e, jevPlan())).resolves.toBeUndefined();
    expect(e.messages).toBe(before);
  });

  test("every answer low-confidence -> original messages; a single low-confidence unit is kept", async () => {
    const all = ev(original());
    const before = all.messages;
    await router(stub(() => ({ score: 0, confidence: 0.2 })).client).apply(all, jevPlan());
    expect(all.messages).toBe(before);

    const some = ev(original());
    await router(stub((id) => ({ score: 0, confidence: id === "u2" ? 0.1 : 0.9 })).client).apply(some, jevPlan());
    expect(ids(some)).toContain("u2"); // unsure about u2: kept
    expect(ids(some)).not.toContain("u1");
  });

  test("garbage answers: wrong kind, unknown names, NaN, out-of-range scores are clamped or ignored", async () => {
    const e = ev(original());
    const client = {
      async ask(_s: unknown, q: Questions): Promise<Answers> {
        const names = Object.keys(q);
        return {
          [names[0]!]: { kind: "noul", probability: 0.9 },
          [names[1]!]: { kind: "score", score: Number.NaN, confidence: 0.9 },
          [names[2]!]: { kind: "score", score: 99, confidence: 0.9 }, // clamps to 4: kept
          [names[3]!]: { kind: "score", score: -5, confidence: 0.9 }, // clamps to 0: dropped
          "unit:not-a-unit": { kind: "score", score: 0, confidence: 1 },
          "unit:u0": { kind: "score", score: 0, confidence: 1 }, // forced, not asked: ignored
          "unit:u7": { kind: "score", score: 0, confidence: 1 },
        } as Answers;
      },
    };
    await router(client).apply(e, jevPlan());
    expect(ids(e)).toContain("u0");
    expect(ids(e)).toContain("u7");
    expect(ids(e)).toContain("u2"); // names[1] unusable -> kept
    expect(ids(e)).toContain("u3"); // names[2] score 99 -> 4
    expect(ids(e)).not.toContain("u4"); // names[3] score -5 -> 0
    expect(findOrphans(e.messages as unknown[])).toEqual([]);
  });

  test("a throwing messages getter or frozen event does not escape", async () => {
    const hostile: any = { sessionID: "s1", agent: "jevCode" };
    Object.defineProperty(hostile, "messages", {
      get() {
        throw new Error("no");
      },
    });
    await expect(router(stub(() => ({ score: 0 })).client).apply(hostile, jevPlan())).resolves.toBeUndefined();
  });
});

describe("token budget", () => {
  test("a small model context window drops the lowest-scored units first; forced units stay even when over budget", async () => {
    // scores: u1=2 u2=3 u3=4 u4=2 u5=3 u6=4; everything >= 2 passes the threshold, the budget decides
    const scores: Record<string, number> = { u1: 2, u2: 3, u3: 4, u4: 2, u5: 3, u6: 4 };
    const { client } = stub((id) => (id in scores ? { score: scores[id]! } : undefined));
    const e = ev(convo(8), { model: { providerID: "p", id: "m", variant: "default" } } as any);
    // each unit is ~700 tokens: forced u0 + u7 ~1400; window 4000 * 0.6 = 2400 -> room for one more unit
    const plan = jevPlan();
    await router(client, { contextWindow: async (m) => (m.id === "m" ? 4000 : undefined) }).apply(e, plan);
    const kept = ids(e).filter((i) => /^u\d$/.test(i));
    expect(kept).toContain("u0");
    expect(kept).toContain("u7");
    expect(kept.length).toBeLessThan(8);
    // the highest-scored non-forced unit survives, the lowest-scored (oldest on ties) are gone
    expect(kept).toContain("u6");
    expect(kept).not.toContain("u1");
    expect(plan.context!.maxTokens).toBe(2400);
  });

  test("an unknown context window means no budget: only relevance decides", async () => {
    const { client } = stub(() => ({ score: 3 }));
    const e = ev(convo(8));
    const before = e.messages;
    await router(client, { contextWindow: async () => undefined }).apply(e, jevPlan());
    expect(e.messages).toBe(before);
  });

  test("window lookup: {data} and array results, cache, timeout and failure return undefined", async () => {
    let calls = 0;
    let t = 0;
    const lookup = createContextWindowLookup(
      async () => {
        calls++;
        return { data: [{ providerID: "p", id: "m", limit: { context: 128_000 } }, { providerID: "p", id: "bad" }, null] };
      },
      { ttlMs: 1000, now: () => t },
    );
    expect(await lookup({ providerID: "p", id: "m" })).toBe(128_000);
    expect(await lookup({ providerID: "p", id: "bad" })).toBeUndefined();
    expect(calls).toBe(1);
    t = 5000;
    await lookup({ providerID: "p", id: "m" });
    expect(calls).toBe(2);
    expect(await createContextWindowLookup(async () => [{ providerID: "q", id: "n", limit: { context: 9 } }])({ providerID: "q", id: "n" })).toBe(9);
    expect(await createContextWindowLookup(() => new Promise(() => {}), { timeoutMs: 20 })({ providerID: "p", id: "m" })).toBeUndefined();
    expect(await createContextWindowLookup(async () => Promise.reject(new Error("x")))({ providerID: "p", id: "m" })).toBeUndefined();
  });
});

describe("many units", () => {
  test("a 500-message conversation is asked with <= 60 questions; a merged group drops all its units", async () => {
    const { client, asks } = stub((id) => (id.includes("+") ? { score: 0 } : { score: 4 }));
    const messages = convo(125); // 500 messages, 125 units
    const e = ev(messages);
    const plan = jevPlan();
    await router(client).apply(e, plan);
    expect(asks).toHaveLength(1);
    const names = Object.keys(asks[0]!.questions);
    expect(names.length).toBeLessThanOrEqual(CONTEXT_MAX_QUESTIONS);
    expect(names.some((n) => n.includes("+"))).toBe(true);
    expect(JSON.stringify(asks[0]!.state).length).toBeLessThanOrEqual(12_000);
    expect(plan.context!.droppedUnitIds!.length).toBeGreaterThan(30); // merged groups hold several units each
    expect(findOrphans(e.messages as unknown[])).toEqual([]);
    expect((e.messages as unknown[]).length).toBeLessThan(messages.length);
  });

  test("questionGroups: individual when few, newest half individual when many, ids unique", () => {
    const units = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `u${i}`, start: i, end: i + 1, tokens: 1, summary: "s" }));
    expect(questionGroups(units(5), 60).map((g) => g.id)).toEqual(["u0", "u1", "u2", "u3", "u4"]);
    const many = questionGroups(units(200), 60);
    expect(many.length).toBeLessThanOrEqual(60);
    expect(many.flatMap((g) => g.units).map((u) => u.id)).toEqual(units(200).map((u) => u.id)); // every unit once, in order
    expect(new Set(many.map((g) => g.id)).size).toBe(many.length);
    expect(many.at(-1)!.units).toHaveLength(1);
    expect(many[0]!.units.length).toBeGreaterThan(1);
  });
});

describe("inside the context hook", () => {
  function hookWith(client: ContextRouterDeps["client"], plan?: TurnPlan) {
    const plans = createPlanCache<TurnPlan>();
    if (plan) plans.set(plan);
    const hook = createContextHook({ options: { alwaysKeepTools: [], toolGroups: {} }, log: { debug() {}, warn() {}, } as any, plans, stages: [router(client)] });
    return hook;
  }

  test("jevCode with a Jev plan prunes, then tool filtering sees only the kept messages", async () => {
    const { client, asks } = stub((id) => ({ score: id === "u1" ? 0 : 4 }));
    const plan = { ...jevPlan(), turnKey: "u7", tools: { groups: ["Exploration"], excluded: ["Development", "Execution"] } };
    const tools = Object.fromEntries(["read", "grep", "edit", "write", "shell"].map((t) => [t, { description: t, input: {} }]));
    // u1's tool call uses "edit": only u1 references... no, odd units use edit; only u1 is dropped, u3/u5/u7 still reference edit
    const e = ev(convo(8), { tools, system: [{ type: "text", text: "sys" }] });
    await hookWith(client, plan)(e);
    expect(asks).toHaveLength(1);
    expect(ids(e)).not.toContain("u1");
    expect(Object.keys(e.tools as object)).toContain("edit"); // still referenced by kept units
    expect(Object.keys(e.tools as object)).not.toContain("write");
  });

  test("build agent: zero Jev calls and nothing changes", async () => {
    const { client, asks } = stub(() => ({ score: 0 }));
    const messages = deepFreeze(convo(8));
    const e: ContextEvent = { sessionID: "s1", agent: "build", messages, system: [{ type: "text", text: "sys" }], tools: { read: {} } };
    const snapshot = structuredClone({ system: e.system, tools: e.tools });
    await hookWith(client, { ...jevPlan(), turnKey: "u7" })(e);
    expect(asks).toHaveLength(0);
    expect(e.messages).toBe(messages);
    expect({ system: e.system, tools: e.tools }).toEqual(snapshot);
  });

  test("stale or missing plan: no pruning, no Jev call (the fallback plan never prunes)", async () => {
    const { client, asks } = stub(() => ({ score: 0 }));
    const e = ev(convo(8));
    const before = e.messages;
    await hookWith(client)(e);
    expect(asks).toHaveLength(0);
    expect(e.messages).toBe(before);
  });
});
