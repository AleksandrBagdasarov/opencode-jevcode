import { describe, expect, test } from "bun:test";
import { createJevClient } from "../../src/jev/client.ts";
import type { Answers, Questions } from "../../src/jev/types.ts";
import { createLogger } from "../../src/log.ts";
import { createPromptHook, type PromptEvent } from "../../src/opencode/prompt-hook.ts";
import { createModelRouter, KEEP, MODEL_QUESTION } from "../../src/router/model-router.ts";
import { fallbackPlan, turnKeyFor, type StageAContributor, type TurnPlan } from "../../src/router/plan.ts";
import {
  createPlanCache,
  createRestoreMemory,
  type ModelRef,
  type StorageLike,
} from "../../src/state/session-state.ts";

const A: ModelRef = { providerID: "mock", id: "m-small" };
const B: ModelRef = { providerID: "mock", id: "m-big" };
const C: ModelRef = { providerID: "mock", id: "m-mid" };

const modelInfo = (id: string) => ({
  providerID: "mock",
  id,
  modelID: id,
  name: id,
  type: "chat",
  status: "active",
  enabled: true,
  capabilities: { tools: true, input: [], output: [] },
  limit: { context: 128_000, output: 4_000 },
  cost: [{ input: 1, output: 5, cache: { read: 0, write: 0 } }],
  time: { released: 0 },
});
const CATALOG = { data: ["m-small", "m-mid", "m-big"].map(modelInfo) };

function fakeStorage(): StorageLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (k) => (data.has(k) ? structuredClone(data.get(k)) : undefined),
    set: async (k, v) => void data.set(k, structuredClone(v)),
    remove: async (k) => void data.delete(k),
  };
}

interface World {
  sessions: Map<string, { agent?: string; model?: ModelRef }>;
  switches: Array<{ sessionID: string; model: ModelRef }>;
  asks: Array<{ state: unknown; questions: Questions }>;
  warnings: unknown[][];
  plans: ReturnType<typeof createPlanCache<TurnPlan>>;
  storage: ReturnType<typeof fakeStorage>;
  hook: (event: PromptEvent) => Promise<void>;
}

function world(opts: {
  answer?: (questions: Questions) => Answers | null | Promise<Answers | null>;
  agent?: string | undefined;
  model?: ModelRef | undefined;
  makeDefault?: boolean;
  switchFails?: boolean;
  getFails?: boolean;
  contributors?: StageAContributor[];
  catalog?: unknown;
  modelMinConfidence?: number;
  variant?: string;
  models?: Array<{ model: string; variant?: string }>;
} = {}): World {
  const sessions = new Map<string, { agent?: string; model?: ModelRef }>();
  const agent = "agent" in opts ? opts.agent : "jevCode";
  const model = "model" in opts ? opts.model : { ...A, variant: opts.variant ?? "default" };
  sessions.set("s1", { ...(agent ? { agent } : {}), ...(model ? { model } : {}) });
  const switches: World["switches"] = [];
  const asks: World["asks"] = [];
  const warnings: unknown[][] = [];
  const storage = fakeStorage();
  const plans = createPlanCache<TurnPlan>();
  const log = { debug() {}, info() {}, warn: (...a: unknown[]) => void warnings.push(a) };
  const ctx = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (opts.getFails) throw new Error("get failed");
        const s = sessions.get(sessionID);
        if (!s) throw new Error("no session");
        return { id: sessionID, ...s };
      },
      switchModel: async (input: { sessionID: string; model: ModelRef }) => {
        if (opts.switchFails) throw new Error("switch failed");
        switches.push(input);
        // the real host reports the model with a variant
        sessions.get(input.sessionID)!.model = { ...input.model, variant: "default" };
      },
    },
  };
  const options = { makeDefault: opts.makeDefault ?? false, models: opts.models ?? [], modelMinConfidence: opts.modelMinConfidence ?? 0.5, timeoutMs: 200 };
  const client = {
    ask: async (state: unknown, questions: Questions) => {
      asks.push({ state, questions });
      return opts.answer ? await opts.answer(questions) : null;
    },
  };
  const hook = createPromptHook({
    ctx,
    options,
    log,
    client,
    memory: createRestoreMemory(storage, log),
    plans,
    contributors: opts.contributors ?? [createModelRouter({ options, log, listModels: async () => opts.catalog ?? CATALOG })],
  });
  return { sessions, switches, asks, warnings, plans, storage, hook };
}

const choose = (choice: string, confidence = 0.9) => (): Answers => ({
  [MODEL_QUESTION]: { kind: "choice", choice, confidence, probabilities: {} },
});
const prompt = (text = "rename foo to bar", messageID = "msg_1"): PromptEvent => ({ sessionID: "s1", messageID, prompt: { text } });

describe("jevCode prompt: model switching", () => {
  test("choice X with enough confidence => exactly one switchModel call with X", async () => {
    const w = world({ answer: choose("mock/m-big", 0.8) });
    await w.hook(prompt());
    expect(w.asks).toHaveLength(1);
    expect(w.switches).toEqual([{ sessionID: "s1", model: { providerID: "mock", id: "m-big" } }]);
    const plan = w.plans.get("s1")!;
    expect(plan.source).toBe("jev");
    expect(plan.fallbackReason).toBeUndefined();
    expect(plan.model).toEqual({ providerID: "mock", id: "m-big", confidence: 0.8 });
    expect(plan.turnKey).toBe("msg_1");
  });

  test("choice with #variant => switchModel is called with { providerID, id, variant }", async () => {
    const w = world({
      models: [{ model: "mock/m-big#high" }, { model: "mock/m-small" }],
      answer: choose("mock/m-big#high", 0.85),
    });
    await w.hook(prompt());
    expect(w.switches).toEqual([{ sessionID: "s1", model: { providerID: "mock", id: "m-big", variant: "high" } }]);
    const plan = w.plans.get("s1")!;
    expect(plan.model).toEqual({ providerID: "mock", id: "m-big", variant: "high", confidence: 0.85 });
  });

  test("the question lists candidate keys and keep, and the state carries the request text", async () => {
    const w = world({ answer: choose("mock/m-big") });
    await w.hook(prompt("make this faster"));
    const q = w.asks[0]!.questions[MODEL_QUESTION]!;
    expect(q.kind === "choice" && Object.keys(q.options).sort()).toEqual(["keep", "mock/m-big", "mock/m-mid", "mock/m-small"]);
    expect(w.asks[0]!.state).toMatchObject({ request: "make this faster", currentModel: "mock/m-small" });
  });

  test("X equal to the current model (ignoring variant) => zero switchModel calls, plan still records the choice", async () => {
    const w = world({ answer: choose("mock/m-small", 0.9) });
    await w.hook(prompt());
    expect(w.switches).toHaveLength(0);
    expect(w.plans.get("s1")).toMatchObject({ source: "jev", model: { id: "m-small" } });
    expect(w.storage.data.size).toBe(0); // nothing to restore later
  });

  test("a switch is remembered with the original model as previous and the host's variant on applied", async () => {
    const w = world({ answer: choose("mock/m-big") });
    await w.hook(prompt());
    expect(w.storage.data.get("restore/s1")).toEqual({
      previous: { providerID: "mock", id: "m-small", variant: "default" },
      applied: { providerID: "mock", id: "m-big", variant: "default" },
    });
  });

  test("a chain of routed turns keeps the user's original model as previous", async () => {
    let next = "mock/m-big";
    const w = world({ answer: () => choose(next)() });
    await w.hook(prompt("one", "msg_1"));
    next = "mock/m-mid";
    await w.hook(prompt("two", "msg_2"));
    expect(w.switches.map((s) => s.model.id)).toEqual(["m-big", "m-mid"]);
    expect(w.storage.data.get("restore/s1")).toMatchObject({ previous: { id: "m-small" }, applied: { id: "m-mid" } });
  });

  test.each([
    ["outside the candidate set", choose("openai/gpt-evil", 0.99), "outside the candidate set"],
    ["below modelMinConfidence", choose("mock/m-big", 0.4), "confidence"],
    ["keep", choose(KEEP, 0.99), "keep"],
    ["a Jev failure (null)", () => null, "Jev unavailable"],
    ["an answer map without the model question", () => ({}), "no model answer"],
  ])("%s => zero switchModel calls and a fallback plan with a reason", async (_n, answer, reason) => {
    const w = world({ answer });
    await w.hook(prompt());
    expect(w.switches).toHaveLength(0);
    const plan = w.plans.get("s1")!;
    expect(plan.source).toBe("fallback");
    expect(plan.model).toBeUndefined();
    expect(plan.skills).toEqual([]);
    expect(plan.tools).toEqual({ groups: [], excluded: [] });
    expect(plan.fallbackReason).toContain(reason);
  });

  test("a timeout (real client, transport that never answers) keeps the model and stores a fallback plan", async () => {
    const log = createLogger({ sink: () => {} });
    const options = { makeDefault: false, models: [], modelMinConfidence: 0.5, timeoutMs: 60 };
    const client = createJevClient({
      options: { provider: "opencode", apiKey: undefined, apiKeySource: "none", endpoint: undefined, jevModel: undefined, timeoutMs: 60 },
      log,
      listModels: async () => ({ data: [{ type: "decision", providerID: "opencode", id: "jev-1", enabled: true }] }),
      generateDecisions: () => new Promise(() => {}),
    });
    const switches: unknown[] = [];
    const plans = createPlanCache<TurnPlan>();
    const hook = createPromptHook({
      ctx: {
        session: {
          get: async () => ({ id: "s1", agent: "jevCode", model: A }),
          switchModel: async (i) => void switches.push(i),
        },
      },
      options,
      log,
      client,
      memory: createRestoreMemory(fakeStorage()),
      plans,
      contributors: [createModelRouter({ options, log, listModels: async () => CATALOG })],
    });
    const t0 = Date.now();
    await hook(prompt());
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(switches).toHaveLength(0);
    expect(plans.get("s1")).toMatchObject({ source: "fallback" });
    expect(plans.get("s1")!.fallbackReason).toContain("Jev unavailable");
  });

  test("switchModel failure keeps the model, records no restore memory and never throws", async () => {
    const w = world({ answer: choose("mock/m-big"), switchFails: true });
    await expect(w.hook(prompt())).resolves.toBeUndefined();
    const plan = w.plans.get("s1")!;
    expect(plan.source).toBe("fallback");
    expect(plan.model).toBeUndefined();
    expect(plan.fallbackReason).toContain("model switch failed");
    expect(w.storage.data.size).toBe(0);
  });

  test("a client that rejects (it should not) still yields a fallback plan, not an exception", async () => {
    const w = world({
      answer: () => {
        throw new Error("client exploded");
      },
    });
    await expect(w.hook(prompt())).resolves.toBeUndefined();
    expect(w.plans.get("s1")).toMatchObject({ source: "fallback", fallbackReason: "prompt hook error" });
    expect(w.switches).toHaveLength(0);
  });

  test("no candidate models => no Jev call, fallback plan with a reason", async () => {
    const w = world({ catalog: { data: [] }, answer: choose("mock/m-big") });
    await w.hook(prompt());
    expect(w.asks).toHaveLength(0);
    expect(w.plans.get("s1")).toMatchObject({ source: "fallback" });
    expect(w.plans.get("s1")!.fallbackReason).toContain("no candidate models");
  });

  test("an unreadable session model => no Jev call, fallback plan", async () => {
    const w = world({ model: undefined, answer: choose("mock/m-big") });
    await w.hook(prompt());
    expect(w.asks).toHaveLength(0);
    expect(w.switches).toHaveLength(0);
    expect(w.plans.get("s1")!.fallbackReason).toBe("session model unreadable");
  });
});

describe("isolation: non-jev agents", () => {
  test("agent build => zero Jev calls, zero plans, zero switches (nothing stored)", async () => {
    const w = world({ agent: "build", answer: choose("mock/m-big") });
    await w.hook(prompt());
    expect(w.asks).toHaveLength(0);
    expect(w.plans.size()).toBe(0);
    expect(w.switches).toHaveLength(0);
    expect(w.storage.data.size).toBe(0);
  });

  test.each(["plan", "jevcode", "jevCode2", "custom"])("agent %s is not jev", async (agent) => {
    const w = world({ agent, answer: choose("mock/m-big") });
    await w.hook(prompt());
    expect(w.asks).toHaveLength(0);
    expect(w.plans.size()).toBe(0);
  });

  test("a non-jev prompt still runs restore: session on the applied model goes back to previous", async () => {
    const w = world({ agent: "build", model: { ...B, variant: "default" }, answer: choose("mock/m-small") });
    await w.storage.set("restore/s1", {
      previous: { providerID: "mock", id: "m-small", variant: "default" },
      applied: { providerID: "mock", id: "m-big", variant: "default" },
    });
    await w.hook(prompt());
    expect(w.asks).toHaveLength(0); // the stub client was never called
    expect(w.plans.size()).toBe(0);
    expect(w.switches).toEqual([{ sessionID: "s1", model: { providerID: "mock", id: "m-small", variant: "default" } }]);
    expect(w.storage.data.size).toBe(0);
  });

  test("restore does not switch over a manual model change", async () => {
    const w = world({ agent: "build", model: { ...C, variant: "default" } });
    w.storage.data.set("restore/s1", { previous: A, applied: B });
    await w.hook(prompt());
    expect(w.switches).toHaveLength(0);
    expect(w.storage.data.size).toBe(0);
  });

  test("an unset agent is non-jev by default and jev with makeDefault", async () => {
    const off = world({ agent: undefined, answer: choose("mock/m-big") });
    await off.hook(prompt());
    expect(off.asks).toHaveLength(0);
    const on = world({ agent: undefined, makeDefault: true, answer: choose("mock/m-big") });
    await on.hook(prompt());
    expect(on.asks).toHaveLength(1);
    expect(on.switches).toHaveLength(1);
  });

  test("a session lookup failure is treated as non-jev (fail closed) and never throws", async () => {
    const w = world({ getFails: true, answer: choose("mock/m-big") });
    await expect(w.hook(prompt())).resolves.toBeUndefined();
    expect(w.asks).toHaveLength(0);
    expect(w.plans.size()).toBe(0);
  });
});

describe("TurnPlan cache", () => {
  test("a plan is stored per sessionID with the turnKey; a second prompt replaces it", async () => {
    const w = world({ answer: choose("mock/m-big") });
    await w.hook(prompt("first", "msg_1"));
    expect(w.plans.getForTurn("s1", "msg_1")).toBeDefined();
    const first = w.plans.get("s1")!;
    await w.hook(prompt("second", "msg_2"));
    expect(w.plans.size()).toBe(1);
    const second = w.plans.get("s1")!;
    expect(second).not.toBe(first);
    expect(second.turnKey).toBe("msg_2");
    expect(w.plans.getForTurn("s1", "msg_1")).toBeUndefined(); // stale key
    expect(w.plans.getForTurn("s1", "msg_2")).toBe(second);
  });

  test("turnKey falls back to a hash of the text when the host sends no message id", async () => {
    const w = world({ answer: choose("mock/m-big") });
    await w.hook({ sessionID: "s1", prompt: { text: "hello" } });
    const key = w.plans.get("s1")!.turnKey;
    expect(key).toBe(turnKeyFor(undefined, "hello"));
    expect(key).not.toBe(turnKeyFor(undefined, "hello!"));
  });

  test("the cache is bounded and plans of other sessions are independent", () => {
    const cache = createPlanCache<TurnPlan>(2);
    for (const id of ["a", "b", "c"]) cache.set(fallbackPlan(id, "k", "r"));
    expect(cache.size()).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toBeDefined();
    cache.delete("c");
    expect(cache.get("c")).toBeUndefined();
  });
});

describe("batched request structure (skills and tool groups plug in here)", () => {
  const extra = (name: string, prefix: string, onApply?: (p: TurnPlan) => void): StageAContributor => ({
    name,
    prepare: () => ({
      questions: { [`${prefix}a`]: { kind: "noul", instructions: "x" } },
      apply: (answers, plan) => {
        const hit = answers?.[`${prefix}a`];
        if (hit?.kind === "noul" && hit.probability > 0.5) {
          onApply?.(plan);
          return { decided: true };
        }
        return { decided: false, reason: "low" };
      },
    }),
  });

  test("every contributor's questions travel in ONE Jev request", async () => {
    const model = createModelRouter({
      options: { models: [], modelMinConfidence: 0.5, timeoutMs: 100 },
      log: { debug() {}, warn() {} },
      listModels: async () => CATALOG,
    });
    const w = world({
      contributors: [model, extra("skills", "skill:"), extra("tools", "tools:")],
      answer: () => ({
        ...choose("mock/m-big")(),
        "skill:a": { kind: "noul", probability: 0.9 },
        "tools:a": { kind: "noul", probability: 0.1 },
      }),
    });
    await w.hook(prompt());
    expect(w.asks).toHaveLength(1);
    expect(Object.keys(w.asks[0]!.questions).sort()).toEqual(["model", "skill:a", "tools:a"]);
    expect(w.plans.get("s1")!.source).toBe("jev");
  });

  test("a contributor that decides keeps the plan 'jev' even when the model stays", async () => {
    const w = world({
      contributors: [extra("skills", "skill:", (p) => p.skills.push("review"))],
      answer: () => ({ "skill:a": { kind: "noul", probability: 0.9 } }),
    });
    await w.hook(prompt());
    expect(w.plans.get("s1")).toMatchObject({ source: "jev", skills: ["review"] });
    expect(w.switches).toHaveLength(0);
  });

  test("a failed model switch does not hide another contributor's decision", async () => {
    const model = createModelRouter({
      options: { models: [], modelMinConfidence: 0.5, timeoutMs: 100 },
      log: { debug() {}, warn() {} },
      listModels: async () => CATALOG,
    });
    const w = world({
      switchFails: true,
      contributors: [model, extra("skills", "skill:", (p) => p.skills.push("review"))],
      answer: () => ({ ...choose("mock/m-big")(), "skill:a": { kind: "noul", probability: 0.9 } }),
    });
    await w.hook(prompt());
    expect(w.plans.get("s1")).toMatchObject({ source: "jev", skills: ["review"] });
    expect(w.plans.get("s1")!.model).toBeUndefined();
  });

  test("a contributor that throws in prepare or apply is dropped; the others still work", async () => {
    const model = createModelRouter({
      options: { models: [], modelMinConfidence: 0.5, timeoutMs: 100 },
      log: { debug() {}, warn() {} },
      listModels: async () => CATALOG,
    });
    const badPrepare: StageAContributor = { name: "bad-prepare", prepare: () => { throw new Error("nope"); } };
    const badApply: StageAContributor = {
      name: "bad-apply",
      prepare: () => ({ questions: { x: { kind: "noul", instructions: "x" } }, apply: (_a, plan) => { plan.skills.push("half-applied"); throw new Error("nope"); } }),
    };
    const w = world({ contributors: [badPrepare, badApply, model], answer: () => ({ ...choose("mock/m-big")(), x: { kind: "noul", probability: 1 } }) });
    await expect(w.hook(prompt())).resolves.toBeUndefined();
    const plan = w.plans.get("s1")!;
    expect(plan.model?.id).toBe("m-big");
    expect(plan.skills).toEqual([]); // the failed apply left no partial state
    expect(w.warnings.length).toBeGreaterThanOrEqual(2);
  });

  test("duplicate question names are rejected for the later contributor", async () => {
    const w = world({ contributors: [extra("one", "q:"), extra("two", "q:")], answer: () => ({ "q:a": { kind: "noul", probability: 0.9 } }) });
    await w.hook(prompt());
    expect(Object.keys(w.asks[0]!.questions)).toEqual(["q:a"]);
  });

  test("with no questions at all there is no Jev call", async () => {
    const w = world({ contributors: [{ name: "idle", prepare: () => ({ skip: "nothing to ask" }) }] });
    await w.hook(prompt());
    expect(w.asks).toHaveLength(0);
    expect(w.plans.get("s1")).toMatchObject({ source: "fallback", fallbackReason: "idle: nothing to ask" });
  });
});

describe("hook robustness", () => {
  test("hostile events never throw", async () => {
    const w = world({ answer: choose("mock/m-big") });
    for (const event of [undefined, null, {}, { sessionID: 5 }, { sessionID: "" }, { sessionID: "s1" }] as unknown as PromptEvent[]) {
      await expect(w.hook(event)).resolves.toBeUndefined();
    }
  });

  test("a plan cache that throws does not make the hook throw", async () => {
    const w = world({ answer: choose("mock/m-big") });
    const hook = createPromptHook({
      ctx: { session: { get: async () => ({ id: "s1", agent: "jevCode", model: A }), switchModel: async () => {} } },
      options: { makeDefault: false },
      log: { debug() {}, info() {}, warn() {} },
      client: { ask: async () => null },
      memory: createRestoreMemory(fakeStorage()),
      plans: { set: () => { throw new Error("full"); }, get: () => undefined, getForTurn: () => undefined, delete: () => {}, size: () => 0 },
      contributors: [],
    });
    await expect(hook(prompt())).resolves.toBeUndefined();
    expect(w.plans.size()).toBe(0);
  });
});
