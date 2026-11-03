import { describe, expect, test } from "bun:test";
import {
  buildCandidates,
  buildModelQuestion,
  buildStageAState,
  CATALOG_TTL_MS,
  createModelRouter,
  decideModel,
  deriveProfile,
  describeCandidate,
  KEEP,
  MAX_CANDIDATES,
  MODEL_QUESTION,
  modelsFrom,
  sameModelId,
  shouldSwitchModel,
  type ModelCandidate,
} from "../../src/router/model-router.ts";
import { fallbackPlan } from "../../src/router/plan.ts";
import type { Answer } from "../../src/jev/types.ts";

function info(providerID: string, id: string, over: Record<string, unknown> = {}) {
  return {
    providerID,
    id,
    modelID: id,
    name: id,
    type: "chat",
    status: "active",
    enabled: true,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 200_000, output: 8_000 },
    cost: [{ input: 3, output: 10, cache: { read: 0, write: 0 } }],
    time: { released: 0 },
    ...over,
  };
}

const keys = (list: ModelCandidate[]) => list.map((c) => c.key);

describe("candidate catalog", () => {
  test("keeps enabled, active, tool-capable chat models only", () => {
    const list = {
      data: [
        info("a", "good"),
        info("a", "disabled", { enabled: false }),
        info("a", "deprecated", { status: "deprecated" }),
        info("a", "alpha", { status: "alpha" }),
        info("a", "beta", { status: "beta" }),
        info("a", "decision", { type: "decision" }),
        info("a", "image", { type: "image" }),
        info("a", "notools", { capabilities: { tools: false, input: [], output: [] } }),
        info("a", "nocaps", { capabilities: undefined }),
        info("a", "unset-type", { type: undefined }),
        info("a", "unset-status", { status: undefined }),
        { providerID: "", id: "x", enabled: true },
        "garbage",
        null,
      ],
    };
    expect(keys(buildCandidates(list)).sort()).toEqual(["a/good", "a/unset-status", "a/unset-type"]);
  });

  test("accepts a bare array and rejects other shapes without throwing", () => {
    expect(keys(buildCandidates([info("a", "m")]))).toEqual(["a/m"]);
    expect(buildCandidates(undefined)).toEqual([]);
    expect(buildCandidates({ data: "nope" })).toEqual([]);
    expect(modelsFrom(null)).toEqual([]);
  });

  test("duplicates collapse to one candidate", () => {
    expect(buildCandidates([info("a", "m"), info("a", "m")])).toHaveLength(1);
  });

  test("is capped at 12 by default", () => {
    const list = Array.from({ length: 40 }, (_, i) => info("p", `m${i}`));
    expect(MAX_CANDIDATES).toBe(12);
    expect(buildCandidates(list)).toHaveLength(12);
    expect(buildCandidates(list, { max: 3 })).toHaveLength(3);
  });

  test("a cap keeps the pinned (current) model and never drops a whole profile", () => {
    const cheap = Array.from({ length: 20 }, (_, i) => info("p", `cheap${i}`, { cost: [{ input: 0.1, output: 0.5, cache: { read: 0, write: 0 } }] }));
    const big = info("p", "big", { cost: [{ input: 15, output: 75, cache: { read: 0, write: 0 } }] });
    const huge = info("p", "huge", { limit: { context: 1_000_000, output: 8_000 } });
    const list = [...cheap, big, huge];
    const out = buildCandidates(list, { max: 4 });
    expect(out.map((c) => c.profile)).toEqual(["fast", "reasoning", "large-context", "fast"]);
    const pinned = buildCandidates(list, { max: 4, pin: "p/cheap19" });
    expect(pinned).toHaveLength(4);
    expect(keys(pinned)).toContain("p/cheap19");
  });

  test("newest release comes first inside a profile", () => {
    const out = buildCandidates([info("p", "old", { time: { released: 1 } }), info("p", "new", { time: { released: 9 } })]);
    expect(keys(out)).toEqual(["p/new", "p/old"]);
  });

  test("allowlist restricts and orders the candidates and can set the profile", () => {
    const list = [info("a", "one"), info("a", "two"), info("b", "three"), info("a", "off", { enabled: false })];
    const out = buildCandidates(list, {
      allowlist: [{ model: "b/three", profile: "reasoning" }, { model: "a/one" }, { model: "a/off" }, { model: "zzz/missing" }],
    });
    expect(keys(out)).toEqual(["b/three", "a/one"]);
    expect(out[0]!.profile).toBe("reasoning");
  });

  test("an allowlist whose models are all unavailable yields no candidates (never falls back to the full list)", () => {
    expect(buildCandidates([info("a", "one")], { allowlist: [{ model: "x/y" }] })).toEqual([]);
  });

  test("candidate carries provider, id, context window, price and a derived profile", () => {
    const [c] = buildCandidates([info("a", "m", { name: "Model M" })]);
    expect(c).toMatchObject({ key: "a/m", providerID: "a", id: "m", name: "Model M", contextWindow: 200_000, inputPrice: 3, outputPrice: 10, profile: "balanced" });
  });

  test("uses the untiered price and tolerates missing cost/limit", () => {
    const [tiered] = buildCandidates([
      info("a", "t", {
        cost: [
          { tier: { type: "context", size: 200_000 }, input: 99, output: 99, cache: { read: 0, write: 0 } },
          { input: 1, output: 2, cache: { read: 0, write: 0 } },
        ],
      }),
    ]);
    expect(tiered).toMatchObject({ inputPrice: 1, outputPrice: 2, profile: "fast" });
    const [bare] = buildCandidates([info("a", "bare", { cost: undefined, limit: undefined })]);
    expect(bare).toMatchObject({ contextWindow: 0, profile: "balanced" });
    expect(bare!.inputPrice).toBeUndefined();
  });

  test("deriveProfile rules", () => {
    expect(deriveProfile(1_000_000, 0.1)).toBe("large-context");
    expect(deriveProfile(400_000, 50)).toBe("large-context");
    expect(deriveProfile(200_000, 0)).toBe("fast");
    expect(deriveProfile(200_000, 2)).toBe("fast");
    expect(deriveProfile(200_000, 5)).toBe("balanced");
    expect(deriveProfile(200_000, 15)).toBe("reasoning");
    expect(deriveProfile(200_000, undefined)).toBe("balanced");
  });
});

describe("model question and decision mapping", () => {
  const cands = buildCandidates([info("a", "one"), info("b", "two")]);

  test("question is a choice over candidate keys plus keep, with descriptions", () => {
    const q = buildModelQuestion(cands);
    expect(q.kind).toBe("choice");
    if (q.kind !== "choice") throw new Error("unreachable");
    expect(Object.keys(q.options).sort()).toEqual(["a/one", "b/two", KEEP].sort());
    expect(q.options["a/one"]).toContain("balanced");
    expect(describeCandidate(cands[0]!)).toContain("200k context");
  });

  const choice = (c: string, confidence: number): Answer => ({ kind: "choice", choice: c, confidence, probabilities: {} });

  test("a candidate at or above the threshold is chosen", () => {
    const d = decideModel(choice("b/two", 0.5), cands, 0.5);
    expect(d).toMatchObject({ kind: "switch", confidence: 0.5 });
    expect(d.kind === "switch" && d.candidate.key).toBe("b/two");
  });

  test.each([
    ["outside the candidate set", choice("evil/model", 0.99), "outside"],
    ["below modelMinConfidence", choice("b/two", 0.49), "confidence"],
    ["keep", choice(KEEP, 0.99), "keep"],
    ["no answer", undefined, "no model answer"],
    ["wrong kind", { kind: "noul", probability: 1 } as Answer, "unexpected kind"],
    ["error answer", { kind: "error", reason: "x" } as Answer, "unexpected kind"],
    ["NaN confidence", choice("b/two", Number.NaN), "confidence"],
  ])("%s => keep with a reason", (_name, answer, reason) => {
    const d = decideModel(answer, cands, 0.5);
    expect(d.kind).toBe("keep");
    expect(d.kind === "keep" && d.reason).toContain(reason);
  });

  test("allowlist with #variant attaches variant to candidate and describes thinking effort", () => {
    const list = [info("opencode", "claude-sonnet-5-5", { name: "Claude Sonnet 5.5" })];
    const out = buildCandidates(list, {
      allowlist: [{ model: "opencode/claude-sonnet-5-5#high", profile: "large-context" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      key: "opencode/claude-sonnet-5-5#high",
      providerID: "opencode",
      id: "claude-sonnet-5-5",
      variant: "high",
      profile: "large-context",
    });
    expect(describeCandidate(out[0]!)).toContain("Claude Sonnet 5.5 (#high thinking effort)");
  });

  test("shouldSwitchModel logic for variants and model ids", () => {
    const base = { providerID: "opencode", id: "gemini" };
    // Same provider and id without variant target does not switch over default variant
    expect(shouldSwitchModel(base, { ...base, variant: "default" })).toBe(false);
    // Explicit variant target differing from current variant switches
    expect(shouldSwitchModel({ ...base, variant: "high" }, { ...base, variant: "default" })).toBe(true);
    expect(shouldSwitchModel({ ...base, variant: "high" }, { ...base, variant: "low" })).toBe(true);
    // Same variant does not switch
    expect(shouldSwitchModel({ ...base, variant: "high" }, { ...base, variant: "high" })).toBe(false);
    // Different model id switches
    expect(shouldSwitchModel({ providerID: "opencode", id: "claude", variant: "high" }, { ...base, variant: "high" })).toBe(true);
    // Unset current model always switches
    expect(shouldSwitchModel(base, undefined)).toBe(true);
  });

  test("sameModelId ignores the variant", () => {
    expect(sameModelId({ providerID: "a", id: "m" }, { providerID: "a", id: "m" })).toBe(true);
    expect(sameModelId({ providerID: "a", id: "m" }, { providerID: "b", id: "m" })).toBe(false);
    expect(sameModelId(undefined, { providerID: "a", id: "m" })).toBe(false);
  });

  test("stage A state is compact: text cut, current model key", () => {
    const state = buildStageAState({ text: "x".repeat(10_000), current: { providerID: "a", id: "m" } });
    expect(state.currentModel).toBe("a/m");
    expect(state.request.length).toBeLessThan(3_100);
  });
});

describe("model router contributor", () => {
  const options = { models: [], modelMinConfidence: 0.5, timeoutMs: 100 };
  const log = { debug() {}, warn() {} };
  const input = (current = { providerID: "a", id: "one" }) => ({ sessionID: "s", turnKey: "t", text: "fix typo", current, prompt: {} });

  test("prepare builds the model question; apply fills plan.model only for a valid choice", async () => {
    const router = createModelRouter({ options, log, listModels: async () => ({ data: [info("a", "one"), info("b", "two")] }) });
    const prepared = await router.prepare(input());
    if ("skip" in prepared) throw new Error("unexpected skip");
    expect(Object.keys(prepared.questions)).toEqual([MODEL_QUESTION]);

    const plan = fallbackPlan("s", "t", "x");
    const ok = await prepared.apply({ model: { kind: "choice", choice: "b/two", confidence: 0.9, probabilities: {} } }, plan);
    expect(ok).toEqual({ decided: true });
    expect(plan.model).toEqual({ providerID: "b", id: "two", confidence: 0.9 });

    const plan2 = fallbackPlan("s", "t", "x");
    const bad = await prepared.apply({ model: { kind: "choice", choice: "z/z", confidence: 0.9, probabilities: {} } }, plan2);
    expect(bad.decided).toBe(false);
    expect(plan2.model).toBeUndefined();
    expect((await prepared.apply(null, plan2)).decided).toBe(false);
    expect((await prepared.apply({}, plan2)).decided).toBe(false);
  });

  test("skips without candidates, when only the current model is a candidate, or when the catalog fails", async () => {
    const none = createModelRouter({ options, log, listModels: async () => ({ data: [] }) });
    expect(await none.prepare(input())).toEqual({ skip: "no candidate models" });

    const only = createModelRouter({ options, log, listModels: async () => ({ data: [info("a", "one")] }) });
    expect(await only.prepare(input())).toMatchObject({ skip: expect.stringContaining("only candidate") });

    const warnings: unknown[] = [];
    const broken = createModelRouter({ options, log: { debug() {}, warn: (...a) => void warnings.push(a) }, listModels: async () => { throw new Error("down"); } });
    expect(await broken.prepare(input())).toEqual({ skip: "model catalog unavailable" });
    expect(warnings).toHaveLength(1);
  });

  test("a hanging model.list is cut off by timeoutMs", async () => {
    const hang = createModelRouter({ options: { ...options, timeoutMs: 30 }, log, listModels: () => new Promise(() => {}) });
    const t0 = Date.now();
    expect(await hang.prepare(input())).toEqual({ skip: "model catalog unavailable" });
    expect(Date.now() - t0).toBeLessThan(500);
  });

  test("allowlist from options is honoured; the catalog is cached for the TTL", async () => {
    let calls = 0;
    let clock = 1_000;
    const router = createModelRouter({
      options: { ...options, models: [{ model: "b/two" }, { model: "a/one" }] },
      log,
      now: () => clock,
      listModels: async () => {
        calls++;
        return { data: [info("a", "one"), info("b", "two"), info("c", "three")] };
      },
    });
    const prepared = await router.prepare(input());
    if ("skip" in prepared) throw new Error("unexpected skip");
    const q = prepared.questions[MODEL_QUESTION]!;
    expect(q.kind === "choice" && Object.keys(q.options)).toEqual(["b/two", "a/one", KEEP]);
    await router.prepare(input());
    expect(calls).toBe(1);
    clock += CATALOG_TTL_MS + 1;
    await router.prepare(input());
    expect(calls).toBe(2);
  });
});
