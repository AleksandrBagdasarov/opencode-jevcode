import { describe, expect, test } from "bun:test";
import { resolveOptions } from "../../src/config.ts";
import { createLogger } from "../../src/log.ts";
import {
  capState,
  createJevClient,
  RERESOLVE_INTERVAL_MS,
  STATE_MAX_CHARS,
  validateQuestions,
  type JevClientDeps,
} from "../../src/jev/client.ts";
import type { Questions } from "../../src/jev/types.ts";

const TS_KEY = "ts-secret-key-111111";
const OR_KEY = "sk-or-secret-key-222222";

const questions: Questions = {
  m: { kind: "choice", instructions: "pick", options: { a: "A", b: "B" } },
  n: { kind: "noul", instructions: "needed?" },
};

const okBody = {
  answers: {
    m: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } },
    n: { type: "noul", noul: 0.8 },
  },
};

const okAnswers = {
  m: { kind: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } },
  n: { kind: "noul", probability: 0.8 },
};

function setup(raw: Record<string, unknown>, env: Record<string, string> = {}, extra: Partial<JevClientDeps> = {}) {
  const lines: string[] = [];
  const options = resolveOptions(raw, env);
  const log = createLogger({ sink: (l) => lines.push(l), debug: true, secrets: [options.apiKey] });
  const client = createJevClient({ options, log, ...extra });
  return { client, lines, options };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function recordingFetch(handler: (n: number, url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (url: string, init?: RequestInit) => {
    calls.push({ url, init: init! });
    return Promise.resolve(handler(calls.length, url, init!));
  };
  return { fn, calls };
}

describe("provider selection (auto)", () => {
  const decisionModel = { providerID: "typesafe", id: "jev-1", type: "decision", enabled: true };
  const chatModel = { providerID: "openai", id: "gpt", type: "chat", enabled: true };

  test("native decision model wins over TYPESAFE and OPENROUTER keys", async () => {
    let nativeCalls = 0;
    const f = recordingFetch(() => json(okBody));
    const { client } = setup({}, { TYPESAFE_API_KEY: TS_KEY, OPENROUTER_API_KEY: OR_KEY }, {
      fetch: f.fn,
      listModels: async () => ({ data: [chatModel, decisionModel] }),
      generateDecisions: async () => {
        nativeCalls++;
        return { answers: [{ type: "choice", name: "m", choice: "a", confidence: 0.9, probabilities: [] }, { type: "predicate", name: "n", probability: 0.8 }] };
      },
    });
    const out = await client.ask({}, questions);
    expect(out?.n).toEqual({ kind: "noul", probability: 0.8 });
    expect(nativeCalls).toBe(1);
    expect(f.calls).toHaveLength(0);
    expect(client.describe().transport).toBe("opencode");
  });

  test("listModels may return a bare array; ids containing jev are preferred", async () => {
    const seen: any[] = [];
    const { client } = setup({}, {}, {
      listModels: async () => [
        { providerID: "x", id: "other-decider", type: "decision" },
        { providerID: "typesafe", id: "jev-1.13", type: "decision" },
      ],
      generateDecisions: async (input) => {
        seen.push(input.model);
        return { answers: [] };
      },
    });
    await client.ask({}, questions);
    expect(seen).toEqual([{ providerID: "typesafe", id: "jev-1.13" }]);
  });

  test("no decision model: TYPESAFE key wins over OPENROUTER key", async () => {
    const f = recordingFetch(() => json(okBody));
    const { client } = setup({}, { TYPESAFE_API_KEY: TS_KEY, OPENROUTER_API_KEY: OR_KEY }, {
      fetch: f.fn,
      listModels: async () => ({ data: [{ providerID: "openai", id: "gpt", type: "chat" }] }),
      generateDecisions: async () => ({ answers: [] }),
    });
    expect(await client.ask({}, questions)).toEqual(okAnswers as any);
    expect(f.calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((f.calls[0]!.init.headers as any).Authorization).toBe(`Bearer ${TS_KEY}`);
    expect(client.describe().transport).toBe("typesafe");
  });

  test("only OPENROUTER key -> openrouter", async () => {
    const f = recordingFetch(() => json(okBody));
    const { client } = setup({}, { OPENROUTER_API_KEY: OR_KEY }, { fetch: f.fn });
    expect(await client.ask({}, questions)).toEqual(okAnswers as any);
    expect(f.calls[0]!.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(client.describe().transport).toBe("openrouter");
  });

  test("apiKey option: typesafe by default, openrouter for sk-or- keys", async () => {
    const f1 = recordingFetch(() => json(okBody));
    await setup({ apiKey: "plain-key-123456" }, {}, { fetch: f1.fn }).client.ask({}, questions);
    expect(f1.calls[0]!.url).toContain("typesafe.ai");
    const f2 = recordingFetch(() => json(okBody));
    await setup({ apiKey: OR_KEY }, {}, { fetch: f2.fn }).client.ask({}, questions);
    expect(f2.calls[0]!.url).toContain("openrouter.ai");
  });

  test("no native, no key -> null with exactly one info notice", async () => {
    const { client, lines } = setup({}, {}, { fetch: recordingFetch(() => json(okBody)).fn });
    expect(await client.ask({}, questions)).toBeNull();
    expect(await client.ask({}, questions)).toBeNull();
    expect(await client.ask({}, questions)).toBeNull();
    expect(lines.filter((l) => l.includes("not available"))).toHaveLength(1);
    expect(client.describe().transport).toBe("none");
  });

  test("explicit providers are honoured", async () => {
    const f = recordingFetch(() => json(okBody));
    const env = { TYPESAFE_API_KEY: TS_KEY, OPENROUTER_API_KEY: OR_KEY };
    await setup({ provider: "openrouter" }, env, { fetch: f.fn }).client.ask({}, questions);
    expect(f.calls[0]!.url).toContain("openrouter.ai");
    expect((f.calls[0]!.init.headers as any).Authorization).toBe(`Bearer ${OR_KEY}`);

    const f2 = recordingFetch(() => json(okBody));
    await setup({ provider: "typesafe" }, env, { fetch: f2.fn }).client.ask({}, questions);
    expect(f2.calls[0]!.url).toContain("typesafe.ai");

    const f3 = recordingFetch(() => json(okBody));
    expect(await setup({ provider: "none" }, env, { fetch: f3.fn }).client.ask({}, questions)).toBeNull();
    expect(f3.calls).toHaveLength(0);

    // explicit typesafe without a typesafe key -> none even if an OpenRouter key exists
    const f4 = recordingFetch(() => json(okBody));
    expect(await setup({ provider: "typesafe" }, { OPENROUTER_API_KEY: OR_KEY }, { fetch: f4.fn }).client.ask({}, questions)).toBeNull();
    expect(f4.calls).toHaveLength(0);

    // explicit opencode ignores HTTP keys
    const f5 = recordingFetch(() => json(okBody));
    expect(await setup({ provider: "opencode" }, env, { fetch: f5.fn, listModels: async () => [] }).client.ask({}, questions)).toBeNull();
    expect(f5.calls).toHaveLength(0);
  });

  test("endpoint and jevModel options reach the transport", async () => {
    const f = recordingFetch(() => json(okBody));
    await setup({ apiKey: TS_KEY, endpoint: "http://127.0.0.1:1/v1", jevModel: "jev-x" }, {}, { fetch: f.fn }).client.ask({ s: 1 }, questions);
    expect(f.calls[0]!.url).toBe("http://127.0.0.1:1/v1");
    const body = JSON.parse(f.calls[0]!.init.body as string);
    expect(body.model).toBe("jev-x");
    expect(body.state).toEqual({ s: 1 });
  });

  test("re-resolves after a none result, at most once per minute; a found transport is kept", async () => {
    let t = 1_000;
    let models: any[] = [];
    let listCalls = 0;
    const { client } = setup({}, {}, {
      now: () => t,
      listModels: async () => (listCalls++, models),
      generateDecisions: async () => ({
        answers: [{ type: "choice", name: "m", choice: "a", confidence: 0.9, probabilities: [] }, { type: "predicate", name: "n", probability: 0.8 }],
      }),
    });
    expect(await client.ask({}, questions)).toBeNull();
    expect(listCalls).toBe(1);
    models = [{ providerID: "typesafe", id: "jev-1", type: "decision" }];

    t += RERESOLVE_INTERVAL_MS - 1;
    expect(await client.ask({}, questions)).toBeNull();
    expect(listCalls).toBe(1); // throttled

    t += 1;
    expect(await client.ask({}, questions)).not.toBeNull();
    expect(listCalls).toBe(2);

    models = [];
    t += 10 * RERESOLVE_INTERVAL_MS;
    expect(await client.ask({}, questions)).not.toBeNull();
    expect(listCalls).toBe(2); // resolved transport is cached
  });

  test("listModels throwing -> falls through to keys, never throws", async () => {
    const f = recordingFetch(() => json(okBody));
    const { client } = setup({}, { TYPESAFE_API_KEY: TS_KEY }, {
      fetch: f.fn,
      listModels: async () => {
        throw new Error("boom");
      },
      generateDecisions: async () => ({ answers: [] }),
    });
    // resolution failure is treated as "no transport" for this round
    expect(await client.ask({}, questions)).toBeNull();
  });
});

describe("fail-open: ask returns null and never throws", () => {
  const base = { TYPESAFE_API_KEY: TS_KEY };

  test("network error (retried once, then null)", async () => {
    const f = recordingFetch(() => {
      throw new TypeError("fetch failed");
    });
    const { client } = setup({}, base, { fetch: f.fn as any });
    expect(await client.ask({}, questions)).toBeNull();
    expect(f.calls).toHaveLength(2);
  });

  test("fetch returning a rejected promise", async () => {
    const f = { fn: () => Promise.reject(new Error("ECONNRESET")) };
    const { client } = setup({}, base, { fetch: f.fn as any });
    expect(await client.ask({}, questions)).toBeNull();
  });

  test("HTTP 4xx: null and NO retry", async () => {
    for (const status of [400, 401, 403, 404, 429]) {
      const f = recordingFetch(() => json({ error: "x" }, status));
      const { client } = setup({}, base, { fetch: f.fn });
      expect(await client.ask({}, questions)).toBeNull();
      expect(f.calls).toHaveLength(1);
    }
  });

  test("HTTP 5xx: one retry then null", async () => {
    const f = recordingFetch(() => json({ error: "x" }, 503));
    const { client } = setup({}, base, { fetch: f.fn });
    expect(await client.ask({}, questions)).toBeNull();
    expect(f.calls).toHaveLength(2);
  });

  test("one retry on 5xx then success", async () => {
    const f = recordingFetch((n) => (n === 1 ? json({}, 502) : json(okBody)));
    const { client } = setup({}, base, { fetch: f.fn });
    expect(await client.ask({}, questions)).toEqual(okAnswers as any);
    expect(f.calls).toHaveLength(2);
  });

  test("one retry on network error then success", async () => {
    const f = recordingFetch((n) => {
      if (n === 1) throw new TypeError("fetch failed");
      return json(okBody);
    });
    const { client } = setup({}, base, { fetch: f.fn as any });
    expect(await client.ask({}, questions)).toEqual(okAnswers as any);
    expect(f.calls).toHaveLength(2);
  });

  test("invalid JSON: null, no retry", async () => {
    const f = recordingFetch(() => new Response("<html>oops</html>", { status: 200 }));
    const { client } = setup({}, base, { fetch: f.fn });
    expect(await client.ask({}, questions)).toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  test("response without answers object", async () => {
    const { client } = setup({}, base, { fetch: recordingFetch(() => json({ hello: 1 })).fn });
    expect(await client.ask({}, questions)).toBeNull();
  });

  test("response missing a requested question -> null", async () => {
    const f = recordingFetch(() => json({ answers: { m: okBody.answers.m } }));
    const { client } = setup({}, base, { fetch: f.fn });
    expect(await client.ask({}, questions)).toBeNull();
  });

  test("all answers are errors -> null", async () => {
    const f = recordingFetch(() => json({ answers: { m: { type: "error", reason: "x" }, n: { type: "bogus" } } }));
    const { client } = setup({}, base, { fetch: f.fn });
    expect(await client.ask({}, questions)).toBeNull();
  });

  test("partial success returns only the usable answers", async () => {
    const f = recordingFetch(() => json({ answers: { m: { type: "error", reason: "x" }, n: { type: "noul", noul: 0.3 } } }));
    const { client } = setup({}, base, { fetch: f.fn });
    expect(await client.ask({}, questions)).toEqual({ n: { kind: "noul", probability: 0.3 } });
  });

  test("answer kind not matching the question is treated as unanswered", async () => {
    const f = recordingFetch(() => json({ answers: { m: { type: "noul", noul: 0.5 }, n: { type: "noul", noul: 0.3 } } }));
    const { client } = setup({}, base, { fetch: f.fn });
    expect(await client.ask({}, questions)).toEqual({ n: { kind: "noul", probability: 0.3 } });
  });

  test("native: generateDecisions throwing synchronously or rejecting -> null", async () => {
    const models = async () => [{ providerID: "t", id: "jev", type: "decision" }];
    const sync = setup({}, {}, {
      listModels: models,
      generateDecisions: (() => {
        throw new Error("sync boom");
      }) as any,
    });
    expect(await sync.client.ask({}, questions)).toBeNull();
    const rej = setup({}, {}, { listModels: models, generateDecisions: async () => Promise.reject(new Error("no")) });
    expect(await rej.client.ask({}, questions)).toBeNull();
    const garbage = setup({}, {}, { listModels: models, generateDecisions: async () => "garbage" });
    expect(await garbage.client.ask({}, questions)).toBeNull();
  });

  test("a transport that throws synchronously (via a fetch that throws synchronously) -> null", async () => {
    const { client } = setup({}, base, {
      fetch: (() => {
        throw new Error("sync fetch failure");
      }) as any,
    });
    expect(await client.ask({}, questions)).toBeNull();
  });

  test("hostile state (circular, BigInt) does not throw", async () => {
    const f = recordingFetch(() => json(okBody));
    const { client } = setup({}, base, { fetch: f.fn });
    const circ: any = {};
    circ.self = circ;
    expect(await client.ask(circ, questions)).toEqual(okAnswers as any);
    expect(await client.ask({ n: 10n }, questions)).toEqual(okAnswers as any);
  });
});

describe("timeout", () => {
  const neverFetch = (url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });

  test("never-resolving fetch that respects the signal returns null within 100ms of timeoutMs, no retry", async () => {
    let calls = 0;
    const { client } = setup({ timeoutMs: 150 }, { TYPESAFE_API_KEY: TS_KEY }, {
      fetch: ((u: string, i?: RequestInit) => (calls++, neverFetch(u, i))) as any,
    });
    const t0 = performance.now();
    const out = await client.ask({}, questions);
    const dt = performance.now() - t0;
    expect(out).toBeNull();
    expect(dt).toBeGreaterThanOrEqual(140);
    expect(dt).toBeLessThan(150 + 100);
    expect(calls).toBe(1);
  });

  test("a transport that ignores the signal is still bounded by the deadline", async () => {
    const { client } = setup({ timeoutMs: 100 }, { TYPESAFE_API_KEY: TS_KEY }, {
      fetch: (() => new Promise(() => {})) as any,
    });
    const t0 = performance.now();
    expect(await client.ask({}, questions)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(200);
  });

  test("retry shares the single deadline (slow 5xx then slow retry stays within ~timeoutMs)", async () => {
    let n = 0;
    const { client } = setup({ timeoutMs: 200 }, { TYPESAFE_API_KEY: TS_KEY }, {
      fetch: ((_u: string, init?: RequestInit) => {
        n++;
        if (n === 1) return new Promise((r) => setTimeout(() => r(json({}, 500)), 120));
        return neverFetch("", init);
      }) as any,
    });
    const t0 = performance.now();
    expect(await client.ask({}, questions)).toBeNull();
    expect(n).toBe(2);
    expect(performance.now() - t0).toBeLessThan(200 + 100);
  });

  test("slow native resolution (listModels hangs) is bounded as well", async () => {
    const { client } = setup({ timeoutMs: 100 }, {}, {
      listModels: () => new Promise(() => {}),
      generateDecisions: async () => ({ answers: [] }),
    });
    const t0 = performance.now();
    expect(await client.ask({}, questions)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("question validation and limits", () => {
  test("empty / malformed question sets -> null without any request", async () => {
    const f = recordingFetch(() => json(okBody));
    const { client } = setup({}, { TYPESAFE_API_KEY: TS_KEY }, { fetch: f.fn });
    expect(await client.ask({}, {})).toBeNull();
    expect(await client.ask({}, null as any)).toBeNull();
    expect(await client.ask({}, { x: { kind: "weird", instructions: "i" } } as any)).toBeNull();
    expect(await client.ask({}, { x: { kind: "noul" } } as any)).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  test("choice <= 255 options, score <= 10 levels", async () => {
    const opts = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, `d${i}`]));
    const levels = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);
    expect(validateQuestions({ c: { kind: "choice", instructions: "i", options: opts(255) } })).toBeNull();
    expect(validateQuestions({ c: { kind: "choice", instructions: "i", options: opts(256) } })).not.toBeNull();
    expect(validateQuestions({ c: { kind: "choice", instructions: "i", options: {} } })).not.toBeNull();
    expect(validateQuestions({ s: { kind: "score", instructions: "i", levels: levels(10) } })).toBeNull();
    expect(validateQuestions({ s: { kind: "score", instructions: "i", levels: levels(11) } })).not.toBeNull();
    expect(validateQuestions({ s: { kind: "score", instructions: "i", levels: levels(1) } })).not.toBeNull();

    const f = recordingFetch(() => json(okBody));
    const { client } = setup({}, { TYPESAFE_API_KEY: TS_KEY }, { fetch: f.fn });
    expect(await client.ask({}, { c: { kind: "choice", instructions: "i", options: opts(256) } })).toBeNull();
    expect(await client.ask({}, { s: { kind: "score", instructions: "i", levels: levels(11) } })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  test("state is capped at STATE_MAX_CHARS", async () => {
    expect(STATE_MAX_CHARS).toBe(12_000);
    const small = { a: 1 };
    expect(capState(small)).toBe(small);
    expect(capState("short")).toBe("short");
    const big = capState({ text: "x".repeat(50_000) }) as string;
    expect(typeof big).toBe("string");
    expect(big.length).toBeLessThanOrEqual(STATE_MAX_CHARS);

    const f = recordingFetch(() => json(okBody));
    const { client } = setup({}, { TYPESAFE_API_KEY: TS_KEY }, { fetch: f.fn });
    await client.ask({ text: "y".repeat(50_000) }, questions);
    const sent = JSON.parse(f.calls[0]!.init.body as string).state;
    expect(typeof sent).toBe("string");
    expect(sent.length).toBeLessThanOrEqual(STATE_MAX_CHARS);
  });
});

describe("secrets", () => {
  test("API key never appears in any logged line (all failure paths, debug on)", async () => {
    const leak = (u: string) => json({ error: `bad key ${TS_KEY}`, url: u }, 500);
    const scenarios: Array<(n: number) => Response> = [
      () => leak("a"),
      () => json({}, 401),
      () => new Response(`nope ${TS_KEY}`, { status: 200 }),
      () => json({ answers: {} }),
    ];
    for (const sc of scenarios) {
      const f = recordingFetch((n) => sc(n));
      const { client, lines } = setup({}, { TYPESAFE_API_KEY: TS_KEY }, { fetch: f.fn });
      await client.ask({}, questions);
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(l).not.toContain(TS_KEY);
    }

    const thrower = recordingFetch(() => {
      throw new Error(`socket closed for Bearer ${TS_KEY}`);
    });
    const { client, lines } = setup({}, { TYPESAFE_API_KEY: TS_KEY }, { fetch: thrower.fn as any });
    await client.ask({}, questions);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toContain(TS_KEY);

    const sinkLines: string[] = [];
    const options = resolveOptions({}, { OPENROUTER_API_KEY: OR_KEY });
    const spy = createLogger({ sink: (l) => sinkLines.push(l), debug: true });
    // key registered by the client itself even if the logger was created without it
    const c2 = createJevClient({ options, log: spy, fetch: (() => Promise.reject(new Error(`x ${OR_KEY}`))) as any });
    await c2.ask({}, questions);
    expect(sinkLines.length).toBeGreaterThan(0);
    for (const l of sinkLines) expect(l).not.toContain(OR_KEY);
  });
});
