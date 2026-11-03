import { describe, expect, test } from "bun:test";
import { DEFAULTS, resolveOptions } from "../src/config.ts";

const noEnv = {};

describe("resolveOptions defaults", () => {
  for (const [label, input] of [
    ["undefined", undefined],
    ["null", null],
    ["{}", {}],
    ["array", []],
    ["string", "nope"],
  ] as const) {
    test(`fully populated from ${label}`, () => {
      const r = resolveOptions(input, noEnv);
      expect(r.provider).toBe("auto");
      expect(r.apiKey).toBeUndefined();
      expect(r.apiKeySource).toBe("none");
      expect(r.timeoutMs).toBe(4000);
      expect(r.models).toEqual([]);
      expect(r.modelMinConfidence).toBe(0.5);
      expect(r.maxSkills).toBe(3);
      expect(r.skillThreshold).toBe(0.6);
      expect(r.toolThreshold).toBe(0.4);
      expect(r.alwaysKeepTools).toEqual([]);
      expect(r.keepRecentMessages).toBe(6);
      expect(r.pruneMinTokens).toBe(12000);
      expect(r.contextMinConfidence).toBe(0.5);
      expect(r.keepFirstUser).toBe(true);
      expect(r.makeDefault).toBe(false);
      expect(r.agentFileFallback).toBe(false);
      expect(r.debug).toBe(false);
      expect(r.fallbackModel).toBeUndefined();
      expect(r.agentModel).toBeUndefined();
    });
  }
});

describe("resolveOptions validation", () => {
  test("wrong types fall back to defaults", () => {
    const r = resolveOptions(
      {
        provider: 42,
        apiKey: 7,
        endpoint: {},
        timeoutMs: "fast",
        models: "x",
        modelMinConfidence: "high",
        maxSkills: null,
        skillThreshold: NaN,
        toolThreshold: Infinity,
        alwaysKeepTools: "read",
        keepRecentMessages: {},
        pruneMinTokens: [],
        contextMinConfidence: true,
        keepFirstUser: "yes",
        makeDefault: 1,
        agentFileFallback: "true",
        debug: "1",
      },
      noEnv,
    );
    expect(r).toMatchObject({
      provider: DEFAULTS.provider,
      timeoutMs: 4000,
      modelMinConfidence: 0.5,
      maxSkills: 3,
      skillThreshold: 0.6,
      toolThreshold: 0.4,
      keepRecentMessages: 6,
      pruneMinTokens: 12000,
      contextMinConfidence: 0.5,
      keepFirstUser: true,
      makeDefault: false,
      agentFileFallback: false,
      debug: false,
    });
    expect(r.apiKey).toBeUndefined();
    expect(r.endpoint).toBeUndefined();
    expect(r.models).toEqual([]);
    expect(r.alwaysKeepTools).toEqual([]);
  });

  test("unknown provider falls back to auto; known ones are kept", () => {
    expect(resolveOptions({ provider: "bogus" }, noEnv).provider).toBe("auto");
    for (const p of ["auto", "opencode", "typesafe", "openrouter", "none"] as const) {
      expect(resolveOptions({ provider: p }, noEnv).provider).toBe(p);
    }
  });

  test("thresholds clamp to 0..1", () => {
    const r = resolveOptions(
      { modelMinConfidence: 5, skillThreshold: -2, toolThreshold: 1.5, contextMinConfidence: -0.1 },
      noEnv,
    );
    expect(r.modelMinConfidence).toBe(1);
    expect(r.skillThreshold).toBe(0);
    expect(r.toolThreshold).toBe(1);
    expect(r.contextMinConfidence).toBe(0);
  });

  test("timeoutMs must be > 0 and is an integer", () => {
    expect(resolveOptions({ timeoutMs: 0 }, noEnv).timeoutMs).toBe(4000);
    expect(resolveOptions({ timeoutMs: -5 }, noEnv).timeoutMs).toBe(4000);
    expect(resolveOptions({ timeoutMs: 0.4 }, noEnv).timeoutMs).toBe(4000);
    expect(resolveOptions({ timeoutMs: 1500.9 }, noEnv).timeoutMs).toBe(1500);
  });

  test("integers are floored and >= 0", () => {
    const r = resolveOptions({ maxSkills: 2.9, keepRecentMessages: -3, pruneMinTokens: 100.7 }, noEnv);
    expect(r.maxSkills).toBe(2);
    expect(r.keepRecentMessages).toBe(0);
    expect(r.pruneMinTokens).toBe(100);
    expect(resolveOptions({ maxSkills: 0 }, noEnv).maxSkills).toBe(0);
  });

  test("valid values are honoured", () => {
    const r = resolveOptions(
      {
        provider: "typesafe",
        endpoint: " https://example.test/v1 ",
        jevModel: "system-one",
        fallbackModel: "anthropic/claude",
        agentModel: "openai/gpt",
        alwaysKeepTools: ["read", "read", "", 5, "grep"],
        keepFirstUser: false,
        makeDefault: true,
        agentFileFallback: true,
        debug: true,
      },
      noEnv,
    );
    expect(r.endpoint).toBe("https://example.test/v1");
    expect(r.jevModel).toBe("system-one");
    expect(r.fallbackModel).toBe("anthropic/claude");
    expect(r.agentModel).toBe("openai/gpt");
    expect(r.alwaysKeepTools).toEqual(["read", "grep"]);
    expect(r.keepFirstUser).toBe(false);
    expect(r.makeDefault).toBe(true);
    expect(r.agentFileFallback).toBe(true);
    expect(r.debug).toBe(true);
  });

  test("invalid model keys are dropped", () => {
    const r = resolveOptions({ fallbackModel: "noslash", agentModel: "/x" }, noEnv);
    expect(r.fallbackModel).toBeUndefined();
    expect(r.agentModel).toBeUndefined();
  });

  test("models allowlist is validated and de-duplicated", () => {
    const r = resolveOptions(
      {
        models: [
          { model: "a/fast", profile: "fast" },
          { model: "b/big", profile: "large-context" },
          { model: "a/fast" },
          { model: "bad" },
          { model: "c/x", profile: "weird" },
          "d/short",
          "nope",
          null,
          42,
          { profile: "fast" },
        ],
      },
      noEnv,
    );
    expect(r.models).toEqual([
      { model: "a/fast", profile: "fast" },
      { model: "b/big", profile: "large-context" },
      { model: "c/x" },
      { model: "d/short" },
    ]);
  });
});

describe("resolveOptions api key", () => {
  test("option wins over env", () => {
    const r = resolveOptions({ apiKey: "ts-opt" }, { TYPESAFE_API_KEY: "ts-env" });
    expect(r.apiKey).toBe("ts-opt");
    expect(r.apiKeySource).toBe("option");
  });

  test("TYPESAFE_API_KEY from env", () => {
    const r = resolveOptions({}, { TYPESAFE_API_KEY: "ts-env" });
    expect(r.apiKey).toBe("ts-env");
    expect(r.apiKeySource).toBe("TYPESAFE_API_KEY");
  });

  test("OPENROUTER_API_KEY from env", () => {
    const r = resolveOptions({}, { OPENROUTER_API_KEY: "sk-or-env" });
    expect(r.apiKey).toBe("sk-or-env");
    expect(r.apiKeySource).toBe("OPENROUTER_API_KEY");
  });

  test("typesafe wins when both set and provider is auto", () => {
    const env = { TYPESAFE_API_KEY: "ts-env", OPENROUTER_API_KEY: "sk-or-env" };
    expect(resolveOptions({}, env).apiKey).toBe("ts-env");
    expect(resolveOptions({ provider: "openrouter" }, env).apiKey).toBe("sk-or-env");
    expect(resolveOptions({ provider: "typesafe" }, env).apiKey).toBe("ts-env");
  });

  test("empty env values are ignored", () => {
    const r = resolveOptions({ apiKey: "  " }, { TYPESAFE_API_KEY: "", OPENROUTER_API_KEY: "  " });
    expect(r.apiKey).toBeUndefined();
  });

  test("never throws on hostile input", () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("boom"); } });
    expect(() => resolveOptions(hostile, noEnv)).not.toThrow();
    expect(resolveOptions(hostile, noEnv).timeoutMs).toBe(4000);
  });
});
