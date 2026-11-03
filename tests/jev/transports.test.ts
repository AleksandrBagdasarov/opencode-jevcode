import { describe, expect, test } from "bun:test";
import { createNativeTransport } from "../../src/jev/transports/native.ts";
import { createOpenRouterTransport } from "../../src/jev/transports/openrouter.ts";
import { createTypesafeTransport } from "../../src/jev/transports/typesafe.ts";
import { JevHttpError, JevProtocolError, type Questions } from "../../src/jev/types.ts";

const KEY = "ts-test-key-123456";
const signal = new AbortController().signal;

const questions: Questions = {
  model: { kind: "choice", instructions: "Pick a model", options: { fast: "cheap and quick", deep: "reasoning" } },
  "skill:git": { kind: "noul", instructions: "Is git needed?" },
  ctx: { kind: "score", instructions: "How relevant?", levels: ["none", "low", "high"] },
};

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(body: unknown, status = 200) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init! });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { fn, calls };
}

const sample = {
  model: "jev-latest",
  answers: {
    model: { type: "choice", choice: "fast", confidence: 0.91, probabilities: { fast: 0.91, deep: 0.09 } },
    "skill:git": { type: "noul", noul: 0.98 },
    ctx: { type: "score", score: 2, confidence: 0.7, legend: "high", probabilities: { high: 0.7 } },
  },
  usage: { cost: 0.0001 },
};

describe("typesafe transport", () => {
  test("sends the documented request and parses noul/choice/score", async () => {
    const f = fakeFetch(sample);
    const t = createTypesafeTransport({ apiKey: KEY, fetch: f.fn });
    const state = { files: ["a.ts"] };
    const answers = await t.ask(state, questions, { signal });

    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.signal).toBe(signal);
    expect(JSON.parse(init.body as string)).toEqual({
      model: "jev-latest",
      state,
      questions: {
        model: { type: "choice", instructions: "Pick a model", criteria: { fast: "cheap and quick", deep: "reasoning" } },
        "skill:git": { type: "noul", instructions: "Is git needed?" },
        ctx: { type: "score", instructions: "How relevant?", criteria: ["none", "low", "high"] },
      },
    });

    expect(answers).toEqual({
      model: { kind: "choice", choice: "fast", confidence: 0.91, probabilities: { fast: 0.91, deep: 0.09 } },
      "skill:git": { kind: "noul", probability: 0.98 },
      ctx: { kind: "score", score: 2, confidence: 0.7 },
    });
  });

  test("honours endpoint and jevModel overrides", async () => {
    const f = fakeFetch(sample);
    const t = createTypesafeTransport({ apiKey: KEY, endpoint: "http://localhost:9/x", model: "jev-1", fetch: f.fn });
    await t.ask("text state", questions, { signal });
    expect(f.calls[0]!.url).toBe("http://localhost:9/x");
    const body = JSON.parse(f.calls[0]!.init.body as string);
    expect(body.model).toBe("jev-1");
    expect(body.state).toBe("text state");
  });

  test("malformed answers become error answers; no answers object is a protocol error", async () => {
    const f = fakeFetch({ answers: { a: { type: "noul" }, b: 5, c: { type: "zzz" } } });
    const t = createTypesafeTransport({ apiKey: KEY, fetch: f.fn });
    const out = await t.ask({}, questions, { signal });
    expect(out.a!.kind).toBe("error");
    expect(out.b!.kind).toBe("error");
    expect(out.c!.kind).toBe("error");

    const bad = createTypesafeTransport({ apiKey: KEY, fetch: fakeFetch({ nope: 1 }).fn });
    await expect(bad.ask({}, questions, { signal })).rejects.toBeInstanceOf(JevProtocolError);
  });

  test("HTTP errors throw JevHttpError without leaking the key; invalid JSON is a protocol error", async () => {
    const t401 = createTypesafeTransport({ apiKey: KEY, fetch: fakeFetch("denied " + KEY, 401).fn });
    const err = await t401.ask({}, questions, { signal }).catch((e) => e);
    expect(err).toBeInstanceOf(JevHttpError);
    expect(err.status).toBe(401);
    expect(String(err.message)).not.toContain(KEY);

    const tjson = createTypesafeTransport({ apiKey: KEY, fetch: fakeFetch("not json").fn });
    await expect(tjson.ask({}, questions, { signal })).rejects.toBeInstanceOf(JevProtocolError);
  });
});

describe("openrouter transport", () => {
  test("sends the documented request (default model, endpoint) and parses answers incl. usage.cost", async () => {
    const f = fakeFetch({ ...sample, usage: { cost: 0.5, input_tokens: 3 } });
    const t = createOpenRouterTransport({ apiKey: "sk-or-abcdef123456", fetch: f.fn });
    const answers = await t.ask({ n: 1 }, questions, { signal });

    const { url, init } = f.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-abcdef123456");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(body.state).toEqual({ n: 1 });
    expect(body.questions.model).toEqual({ type: "choice", instructions: "Pick a model", criteria: { fast: "cheap and quick", deep: "reasoning" } });
    expect(body.questions["skill:git"]).toEqual({ type: "noul", instructions: "Is git needed?" });
    expect(body.questions.ctx).toEqual({ type: "score", instructions: "How relevant?", criteria: ["none", "low", "high"] });
    expect(answers["skill:git"]).toEqual({ kind: "noul", probability: 0.98 });
    expect(answers.model!.kind).toBe("choice");
    expect(answers.ctx).toEqual({ kind: "score", score: 2, confidence: 0.7 });
  });

  test("model override", async () => {
    const f = fakeFetch(sample);
    const t = createOpenRouterTransport({ apiKey: "sk-or-abcdef123456", model: "x/y", fetch: f.fn });
    await t.ask({}, questions, { signal });
    expect(JSON.parse(f.calls[0]!.init.body as string).model).toBe("x/y");
  });
});

describe("native transport", () => {
  const model = { providerID: "typesafe", id: "jev-1" };

  test("maps noul->predicate, choice->choices, score->levels and parses all answer kinds", async () => {
    let seen: any;
    let seenOpts: any;
    const t = createNativeTransport({
      model,
      generateDecisions: async (input, opts) => {
        seen = input;
        seenOpts = opts;
        return {
          answers: [
            { type: "choice", name: "model", choice: "fast", probabilities: [{ value: "fast", probability: 0.8 }, { value: "deep", probability: 0.2 }], confidence: 0.8 },
            { type: "predicate", name: "skill:git", probability: 0.4 },
            { type: "score", name: "ctx", score: 3, probabilities: [{ value: 3, label: "high", probability: 0.6 }], confidence: 0.6 },
            { type: "error", name: "extra", reason: "bad", message: "details" },
          ],
        };
      },
    });
    const state = { a: 1 };
    const out = await t.ask(state, questions, { signal });

    expect(seen).toEqual({
      model,
      input: [{ type: "json", value: state }],
      questions: [
        { type: "choice", name: "model", instructions: "Pick a model", choices: [{ value: "fast", description: "cheap and quick" }, { value: "deep", description: "reasoning" }] },
        { type: "predicate", name: "skill:git", instructions: "Is git needed?" },
        { type: "score", name: "ctx", instructions: "How relevant?", levels: [{ label: "none" }, { label: "low" }, { label: "high" }] },
      ],
    });
    expect(seenOpts.signal).toBe(signal);
    expect(out).toEqual({
      model: { kind: "choice", choice: "fast", confidence: 0.8, probabilities: { fast: 0.8, deep: 0.2 } },
      "skill:git": { kind: "noul", probability: 0.4 },
      ctx: { kind: "score", score: 3, confidence: 0.6 },
      extra: { kind: "error", reason: "bad: details" },
    });
  });

  test("string state is sent as text input", async () => {
    let seen: any;
    const t = createNativeTransport({ model, generateDecisions: async (i) => ((seen = i), { answers: [] }) });
    await t.ask("hello", questions, { signal });
    expect(seen.input).toEqual([{ type: "text", text: "hello" }]);
  });

  test("rejection becomes a network error without payload; missing answers array is a protocol error", async () => {
    const t = createNativeTransport({
      model,
      generateDecisions: async () => {
        throw new Error("boom " + KEY);
      },
    });
    const err = await t.ask({}, questions, { signal }).catch((e) => e);
    expect(err.name).toBe("JevNetworkError");
    expect(String(err.message)).not.toContain(KEY);

    const bad = createNativeTransport({ model, generateDecisions: async () => ({}) });
    await expect(bad.ask({}, questions, { signal })).rejects.toBeInstanceOf(JevProtocolError);
  });
});
