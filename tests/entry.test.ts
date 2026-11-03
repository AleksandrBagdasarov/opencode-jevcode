import { describe, expect, test } from "bun:test";
import type { Module } from "../src/modules.ts";
import { setupPlugin } from "../src/setup.ts";

interface FakeCtx {
  options?: unknown;
}

function run(modules: Module<FakeCtx>[], options: unknown = {}, env: Record<string, string> = {}) {
  const lines: string[] = [];
  const p = setupPlugin<FakeCtx>({ options }, modules, { env, sink: (l) => lines.push(l) });
  return { p, lines };
}

describe("setupPlugin", () => {
  test("with no modules it resolves to a cleanup function", async () => {
    const { p } = run([]);
    const cleanup = await p;
    expect(typeof cleanup).toBe("function");
    await cleanup();
  });

  test("a module that throws synchronously does not make setup throw", async () => {
    const order: string[] = [];
    const { p, lines } = run([
      { name: "bad", init: () => { throw new Error("sync boom"); } },
      { name: "good", init: () => { order.push("good"); } },
    ]);
    await expect(p).resolves.toBeFunction();
    expect(order).toEqual(["good"]);
    expect(lines.join("\n")).toContain("module bad failed");
    expect(lines.join("\n")).toContain("sync boom");
  });

  test("a module that rejects does not make setup throw", async () => {
    const { p, lines } = run([{ name: "async-bad", init: async () => { throw new Error("async boom"); } }]);
    await expect(p).resolves.toBeFunction();
    expect(lines.join("\n")).toContain("async boom");
  });

  test("modules receive resolved options and logger", async () => {
    let seen: unknown;
    const { p } = run(
      [{ name: "peek", init: (_ctx, deps) => { seen = deps.options.timeoutMs; } }],
      { timeoutMs: 1234 },
    );
    await p;
    expect(seen).toBe(1234);
  });

  test("cleanup disposes tracked registrations newest-first, even if one throws", async () => {
    const order: string[] = [];
    const { p } = run([
      { name: "a", init: () => ({ dispose: () => void order.push("a") }) },
      {
        name: "b",
        init: (_c, deps) => {
          deps.track(() => { order.push("b"); throw new Error("dispose fail"); });
        },
      },
      { name: "c", init: async () => async () => void order.push("c") },
    ]);
    const cleanup = await p;
    await expect(Promise.resolve(cleanup())).resolves.toBeUndefined();
    expect(order).toEqual(["c", "b", "a"]);
    await cleanup(); // idempotent
    expect(order).toEqual(["c", "b", "a"]);
  });

  test("hostile ctx / options never make setup throw", async () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("nope"); } }) as FakeCtx;
    const lines: string[] = [];
    await expect(setupPlugin(hostile, [], { sink: (l) => lines.push(l) })).resolves.toBeFunction();
    await expect(setupPlugin(undefined as unknown as FakeCtx, [], { sink: () => {} })).resolves.toBeFunction();
  });

  test("api key never appears in log output, including module errors", async () => {
    const { p, lines } = run(
      [{ name: "leaky", init: () => { throw new Error("failed with key super-secret-key-123"); } }],
      { apiKey: "super-secret-key-123", debug: true },
    );
    await p;
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("super-secret-key-123");
  });
});

describe("package entry", () => {
  test("default export is a plugin with id jevcode that tolerates a minimal ctx", async () => {
    const mod = await import("../src/index.ts");
    const plugin = mod.default;
    expect(plugin.id).toBe("jevcode");
    expect(typeof plugin.setup).toBe("function");
    expect(mod.MODULES).toEqual([]);
    const cleanup = await plugin.setup({ options: {} } as never);
    expect(typeof cleanup).toBe("function");
    if (typeof cleanup === "function") await cleanup();
  });
});
