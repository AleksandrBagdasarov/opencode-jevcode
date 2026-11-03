/**
 * QA end-to-end checks for ticket 0008 against the REAL `opencode` binary (mock OpenAI-compatible provider +
 * mock TypeSafe-shaped Jev). Skipped unless OPENCODE_INTEGRATION=1:
 *
 *   $env:OPENCODE_INTEGRATION=1; bun test tests/e2e
 *
 * The plugin under test is the repository root by default. Set JEVCODE_E2E_PLUGIN to another directory (for
 * example the unpacked/installed npm tarball) to run the same checks against that copy.
 *
 * Covers what the other integration files do not:
 *  - the plugin loads and /api/agent lists jevCode;
 *  - a `build` prompt produces model requests IDENTICAL to a run with the plugin removed from the config;
 *  - Jev answering 500, Jev hanging past `timeoutMs`, Jev unreachable (closed port) and `provider: "none"`:
 *    jevCode still completes the turn on the kept model.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const enabled = process.env.OPENCODE_INTEGRATION === "1";
const pluginRoot = resolve(process.env.JEVCODE_E2E_PLUGIN ?? join(import.meta.dir, "..", ".."));
const fixture = resolve(import.meta.dir, "..", "integration", "fixtures", "mock-provider.plugin.ts");

interface ModelRequest {
  model: string;
  /** Request body as JSON text. */
  raw: string;
}

describe.skipIf(!enabled)("publish readiness e2e on the real opencode binary", () => {
  let base: string;
  let modelServer: ReturnType<typeof Bun.serve>;
  let jevServer: ReturnType<typeof Bun.serve>;
  let closedPort = 0;
  const modelRequests: ModelRequest[] = [];
  let jevCount = 0;
  let jevMode: "ok" | "500" | "hang" = "ok";
  let isolatedEnv: Record<string, string> = {};

  function writeConfig(pluginOptions: Record<string, unknown> | null) {
    const config = pluginOptions === null ? {} : { plugins: [{ package: pluginRoot.replaceAll("\\", "/"), options: pluginOptions }] };
    writeFileSync(join(base, "opencode.jsonc"), JSON.stringify(config));
  }

  function jevOptions(over: Record<string, unknown> = {}) {
    return {
      provider: "typesafe",
      apiKey: "ts-e2e-test-key",
      endpoint: `http://127.0.0.1:${jevServer.port}/v1/systemone`,
      timeoutMs: 1500,
      models: ["mock/m-small", "mock/m-mid", "mock/m-big"],
      ...over,
    };
  }

  async function opencode(args: string[], withMock = true) {
    const bin = Bun.which("opencode");
    if (!bin) throw new Error("opencode binary not found on PATH");
    const proc = Bun.spawn([bin, "--standalone", ...args], {
      cwd: base,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...isolatedEnv, ...(withMock ? { JEVCODE_TEST_MOCK_BASE_URL: `http://127.0.0.1:${modelServer.port}/v1` } : {}) },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }

  async function run(agent: string, startModel: string, message: string) {
    modelRequests.length = 0;
    jevCount = 0;
    const started = Date.now();
    const r = await opencode(["run", "--agent", agent, "--model", startModel, message]);
    if (r.code !== 0) console.log(`opencode exited with ${r.code}\n${r.stdout}\n${r.stderr.slice(-2000)}`);
    return { ...r, ms: Date.now() - started, models: modelRequests.map((m) => m.model), bodies: modelRequests.map((m) => m.raw).sort(), jev: jevCount };
  }

  beforeAll(() => {
    modelServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "m-small" }, { id: "m-mid" }, { id: "m-big" }] });
        const body = (await req.json().catch(() => ({}))) as { model?: string; stream?: boolean };
        modelRequests.push({ model: String(body.model), raw: JSON.stringify(body) });
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        if (!body.stream) {
          return Response.json({
            id: "c1",
            object: "chat.completion",
            created: 1,
            model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: `answered by ${body.model}` }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          });
        }
        const text =
          chunk({ role: "assistant", content: `answered by ${body.model}` }, null) +
          chunk({}, "stop") +
          `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n` +
          "data: [DONE]\n\n";
        return new Response(text, { headers: { "content-type": "text/event-stream" } });
      },
    });
    jevServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        jevCount++;
        const body = (await req.json().catch(() => ({}))) as { questions?: Record<string, { type?: string; criteria?: Record<string, unknown> }> };
        if (jevMode === "500") return new Response("internal error", { status: 500 });
        if (jevMode === "hang") return new Promise<Response>(() => {}); // never answers
        const answers: Record<string, unknown> = {};
        for (const [name, q] of Object.entries(body.questions ?? {})) {
          if (name === "model") answers[name] = { type: "choice", choice: "mock/m-big", confidence: 0.93, probabilities: { "mock/m-big": 0.93 } };
          else if (q.type === "noul") answers[name] = { type: "noul", noul: name.startsWith("skill:") ? 0.05 : 0.95 };
          else if (q.type === "choice") answers[name] = { type: "choice", choice: Object.keys(q.criteria ?? {})[0], confidence: 0.5, probabilities: {} };
          else answers[name] = { type: "score", score: 0, confidence: 0.5 };
        }
        return Response.json({ answers });
      },
    });
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    closedPort = probe.port ?? 0;
    probe.stop(true); // nothing listens here any more: connection refused

    base = mkdtempSync(join(tmpdir(), "jev-qa8-"));
    const home = join(base, ".isolated-home");
    for (const d of ["config", "data", "cache", "state"]) mkdirSync(join(home, d), { recursive: true });
    isolatedEnv = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state") };
    mkdirSync(join(base, ".opencode", "plugins", "mock-provider"), { recursive: true });
    copyFileSync(fixture, join(base, ".opencode", "plugins", "mock-provider", "index.ts"));
  });

  afterAll(() => {
    modelServer?.stop(true);
    jevServer?.stop(true);
    if (base) rmSync(base, { recursive: true, force: true });
  });

  test("the plugin loads and /api/agent lists jevCode (primary); without the plugin it does not", async () => {
    writeConfig(jevOptions());
    const on = await opencode(["api", "get", "/api/agent"]);
    expect(on.code).toBe(0);
    const agents = (JSON.parse(on.stdout).data as Array<{ id: string; mode: string }>);
    expect(agents.find((a) => a.id === "jevCode")?.mode).toBe("primary");
    expect(on.stderr).not.toContain("NOT in the agent list");
    expect(on.stderr).not.toContain("[jevcode] error");
    writeConfig(null);
    const off = await opencode(["api", "get", "/api/agent"]);
    expect((JSON.parse(off.stdout).data as Array<{ id: string }>).some((a) => a.id === "jevCode")).toBe(false);
  }, 120_000);

  test("build prompt: model requests are identical with the plugin enabled and with the plugin removed", async () => {
    jevMode = "ok";
    writeConfig(null);
    const off = await run("build", "mock/m-small", "say hello");
    writeConfig(jevOptions());
    const on = await run("build", "mock/m-small", "say hello");
    console.log("QA identical: requests off/on =", off.bodies.length, on.bodies.length, "jev requests on =", on.jev);
    expect(off.code).toBe(0);
    expect(on.code).toBe(0);
    expect(off.bodies.length).toBeGreaterThan(0);
    expect(on.jev).toBe(0);
    expect(on.bodies).toEqual(off.bodies);
  }, 180_000);

  const failing: Array<[string, () => void, Record<string, unknown>]> = [
    ["Jev answering 500", () => (jevMode = "500"), {}],
    ["Jev hanging past timeoutMs", () => (jevMode = "hang"), { timeoutMs: 1500 }],
    ["Jev unreachable (connection refused)", () => (jevMode = "ok"), { endpoint: "http://127.0.0.1:CLOSED/v1/systemone" }],
    ['provider "none"', () => (jevMode = "ok"), { provider: "none" }],
  ];
  for (const [label, setMode, over] of failing) {
    test(`${label}: jevCode completes the turn on the kept model`, async () => {
      setMode();
      const o = { ...over } as Record<string, unknown>;
      if (typeof o.endpoint === "string") o.endpoint = o.endpoint.replace("CLOSED", String(closedPort));
      writeConfig(jevOptions(o));
      const r = await run("jevCode", "mock/m-mid", "say hello");
      console.log(`QA fail-open [${label}]: exit=${r.code} models=${JSON.stringify([...new Set(r.models)])} jevRequests=${r.jev} ms=${r.ms}`);
      expect(r.code).toBe(0);
      expect(r.models.length).toBeGreaterThan(0);
      expect(new Set(r.models)).toEqual(new Set(["m-mid"]));
      expect(r.stdout).toContain("answered by m-mid");
    }, 180_000);
  }
});
