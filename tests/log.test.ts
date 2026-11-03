import { describe, expect, test } from "bun:test";
import { createLogger, redact } from "../src/log.ts";

function capture(opts: Parameters<typeof createLogger>[0] = {}) {
  const lines: string[] = [];
  const log = createLogger({ ...opts, sink: (l) => lines.push(l) });
  return { log, lines };
}

describe("logger", () => {
  test("prefixes lines and writes levels", () => {
    const { log, lines } = capture({ debug: true });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines).toEqual(["[jevcode] debug: d", "[jevcode] i", "[jevcode] warn: w", "[jevcode] error: e"]);
  });

  test("debug is suppressed unless enabled", () => {
    const { log, lines } = capture();
    log.debug("hidden");
    log.info("shown");
    expect(lines).toEqual(["[jevcode] shown"]);
  });

  test("default sink writes to stderr via console.error", () => {
    const orig = console.error;
    const seen: string[] = [];
    console.error = (...a: unknown[]) => void seen.push(a.join(" "));
    try {
      createLogger().warn("hello");
    } finally {
      console.error = orig;
    }
    expect(seen).toEqual(["[jevcode] warn: hello"]);
  });

  test("formats errors and objects", () => {
    const { log, lines } = capture();
    log.error("failed:", new Error("boom"), { a: 1 });
    expect(lines[0]).toContain("boom");
    expect(lines[0]).toContain('{"a":1}');
  });
});

describe("redaction", () => {
  const KEY = "ts-abcdef1234567890";

  test("registered secrets never appear in output", () => {
    const { log, lines } = capture({ debug: true, secrets: ["custom-secret-value"] });
    log.info("key is custom-secret-value ok");
    log.error("again", { token: "custom-secret-value" }, new Error("x custom-secret-value"));
    expect(lines.join("\n")).not.toContain("custom-secret-value");
    expect(lines.join("\n")).toContain("***");
  });

  test("addSecret registers later secrets", () => {
    const { log, lines } = capture();
    log.addSecret("late-secret-9");
    log.warn("use late-secret-9");
    expect(lines[0]).not.toContain("late-secret-9");
  });

  test("common key patterns are masked without registration", () => {
    const text = `ts key ${KEY}, or key sk-or-v1-abcdef123456, openai sk-abcdefghijklmnop, header Authorization: Bearer abc.DEF-123_x/y=`;
    const out = redact(text);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain("sk-or-v1-abcdef123456");
    expect(out).not.toContain("sk-abcdefghijklmnop");
    expect(out).not.toContain("abc.DEF-123_x/y=");
    expect(out).toContain("Bearer ***");
  });

  test("logger masks pattern keys in every level", () => {
    const { log, lines } = capture({ debug: true });
    for (const level of ["debug", "info", "warn", "error"] as const) log[level](`k=${KEY}`);
    expect(lines.join("\n")).not.toContain(KEY);
  });

  test("an api key from resolved options is redacted", async () => {
    const { resolveOptions } = await import("../src/config.ts");
    const r = resolveOptions({}, { OPENROUTER_API_KEY: "opaque-key-value-123" });
    const { log, lines } = capture({ secrets: [r.apiKey] });
    log.error("request failed with opaque-key-value-123");
    expect(lines[0]).not.toContain("opaque-key-value-123");
  });

  test("ordinary text is untouched", () => {
    expect(redact("model anthropic/claude-sonnet timeout 4000ms")).toBe("model anthropic/claude-sonnet timeout 4000ms");
  });

  test("logging never throws (circular, throwing sink)", () => {
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    const log = createLogger({
      sink: () => {
        throw new Error("sink down");
      },
    });
    expect(() => log.error("x", circ)).not.toThrow();
  });
});
