/**
 * End-to-end check of tool group routing and the context hook against the REAL `opencode` binary with a mock
 * OpenAI-compatible provider and a mock TypeSafe (Jev) endpoint (ticket 0006). Skipped unless OPENCODE_INTEGRATION=1:
 *
 *   $env:OPENCODE_INTEGRATION=1; bun test tests/integration/context-hook.int.test.ts
 *
 * Evidence asserted (opencode 2.2.5):
 *  - the stage-A request carries one `tools:<group>` noul question per group, in the same single Jev request;
 *  - with every group kept, the agent's model request has the full tool set and the routing note;
 *  - with only Exploration kept, the model request of the SAME agent loses the tools of the excluded groups (so the
 *    cached plan's turnKey matched the latest user message of the real context event), keeps the Exploration tools
 *    and says so in the system prompt;
 *  - a `build` prompt is never filtered, gets no routing note and makes zero Jev requests.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const enabled = process.env.OPENCODE_INTEGRATION === "1";
const repoRoot = resolve(import.meta.dir, "..", "..");
const fixture = resolve(import.meta.dir, "fixtures", "mock-provider.plugin.ts");

interface ModelRequest {
  model: string;
  toolNames: string[];
  system: string;
}
interface JevRequest {
  body: { questions?: Record<string, { type?: string }> };
}

describe.skipIf(!enabled)("tool routing + context hook on the real opencode binary", () => {
  let base: string;
  let modelServer: ReturnType<typeof Bun.serve>;
  let jevServer: ReturnType<typeof Bun.serve>;
  let isolatedEnv: Record<string, string> = {};
  const modelRequests: ModelRequest[] = [];
  const jevRequests: JevRequest[] = [];
  let jevMode: "keep-all" | "exploration-only" = "keep-all";

  async function run(agent: string, message: string) {
    const bin = Bun.which("opencode");
    if (!bin) throw new Error("opencode binary not found on PATH");
    modelRequests.length = 0;
    jevRequests.length = 0;
    const proc = Bun.spawn([bin, "--standalone", "run", "--agent", agent, "--model", "mock/m-small", message], {
      cwd: base,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...isolatedEnv, JEVCODE_TEST_MOCK_BASE_URL: `http://127.0.0.1:${modelServer.port}/v1` },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) console.log(`opencode exited with ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr.slice(-3000)}`);
    // The agent request is the one that offers tools (the title request has none).
    const agentRequests = modelRequests.filter((r) => r.toolNames.length > 0);
    return { code, agentRequests, jev: [...jevRequests] };
  }

  beforeAll(() => {
    modelServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "m-small" }, { id: "m-mid" }, { id: "m-big" }] });
        const body = (await req.json().catch(() => ({}))) as {
          model?: string;
          stream?: boolean;
          tools?: Array<{ function?: { name?: string } }>;
          messages?: Array<{ role?: string; content?: unknown }>;
        };
        modelRequests.push({
          model: String(body.model),
          toolNames: (body.tools ?? []).map((t) => String(t.function?.name)),
          system: (body.messages ?? []).filter((m) => m.role === "system").map((m) => JSON.stringify(m.content)).join("\n"),
        });
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        if (!body.stream) {
          return Response.json({
            id: "c1",
            object: "chat.completion",
            created: 1,
            model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          });
        }
        const text =
          chunk({ role: "assistant", content: "ok" }, null) +
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
        const body = (await req.json().catch(() => ({}))) as JevRequest["body"];
        jevRequests.push({ body });
        // The client treats any unanswered question as a failure, so answer EVERY asked question.
        const answers: Record<string, unknown> = {};
        for (const [name, q] of Object.entries(body.questions ?? {})) {
          if (name === "model") answers[name] = { type: "choice", choice: "keep", confidence: 0.9, probabilities: { keep: 0.9 } };
          else if (name.startsWith("tools:")) {
            const keep = jevMode === "keep-all" || name === "tools:Exploration";
            answers[name] = { type: "noul", noul: keep ? 0.9 : 0.05 };
          } else if (q.type === "noul") answers[name] = { type: "noul", noul: 0.05 };
          else answers[name] = { type: "score", score: 0, confidence: 0.5 };
        }
        return Response.json({ answers });
      },
    });

    base = mkdtempSync(join(tmpdir(), "jev-e2e-ctx-"));
    const home = join(base, ".isolated-home");
    for (const d of ["config", "data", "cache", "state"]) mkdirSync(join(home, d), { recursive: true });
    isolatedEnv = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_STATE_HOME: join(home, "state"),
    };
    mkdirSync(join(base, ".opencode", "plugins", "mock-provider"), { recursive: true });
    copyFileSync(fixture, join(base, ".opencode", "plugins", "mock-provider", "index.ts"));
    const config = {
      plugins: [
        {
          package: repoRoot.replaceAll("\\", "/"),
          options: {
            provider: "typesafe",
            apiKey: "ts-e2e-test-key",
            endpoint: `http://127.0.0.1:${jevServer.port}/v1/systemone`,
            timeoutMs: 3000,
            models: ["mock/m-small", "mock/m-mid", "mock/m-big"],
            debug: true,
          },
        },
      ],
    };
    writeFileSync(join(base, "opencode.jsonc"), JSON.stringify(config));
  });

  afterAll(() => {
    modelServer?.stop(true);
    jevServer?.stop(true);
    if (base) rmSync(base, { recursive: true, force: true });
  });

  let allTools: string[] = [];

  test("all groups kept: full tool set, one batched Jev request with tool group questions, routing note", async () => {
    jevMode = "keep-all";
    const r = await run("jevCode", "say hello");
    console.log("E2E tools keep-all:", r.agentRequests[0]?.toolNames);
    expect(r.code).toBe(0);
    expect(r.jev).toHaveLength(1);
    const names = Object.keys(r.jev[0]!.body.questions!);
    for (const g of ["Exploration", "Development", "Execution", "Verification", "Research", "Delegation", "Database"]) {
      expect(names).toContain(`tools:${g}`);
    }
    expect(r.agentRequests.length).toBeGreaterThan(0);
    allTools = r.agentRequests[0]!.toolNames;
    expect(allTools.length).toBeGreaterThan(3);
    expect(r.agentRequests[0]!.system).toContain("[jevCode routing]");
  }, 120_000);

  test("only Exploration kept: tools of the other groups are gone from the model request", async () => {
    jevMode = "exploration-only";
    const r = await run("jevCode", "say hello again");
    console.log("E2E tools exploration-only:", r.agentRequests[0]?.toolNames);
    expect(r.code).toBe(0);
    expect(r.jev).toHaveLength(1);
    expect(r.agentRequests.length).toBeGreaterThan(0);
    for (const req of r.agentRequests) {
      const tools = req.toolNames;
      expect(tools.length).toBeLessThan(allTools.length);
      for (const t of tools) expect(allTools).toContain(t);
      for (const gone of ["edit", "write", "patch", "apply_patch", "shell", "bash", "task", "subagent", "webfetch", "websearch"]) {
        expect(tools).not.toContain(gone);
      }
      for (const kept of ["read", "grep", "glob"]) if (allTools.includes(kept)) expect(tools).toContain(kept);
      expect(req.system).toContain("[jevCode routing]");
      expect(req.system).toContain("left out");
    }
  }, 120_000);

  test("build prompt: zero Jev requests, full tool set, no routing note", async () => {
    jevMode = "exploration-only";
    const r = await run("build", "say hello");
    expect(r.code).toBe(0);
    expect(r.jev).toHaveLength(0);
    expect(r.agentRequests.length).toBeGreaterThan(0);
    expect(r.agentRequests[0]!.system).not.toContain("[jevCode routing]");
    expect(r.agentRequests[0]!.toolNames).toContain("read");
    expect(r.agentRequests[0]!.toolNames.length).toBeGreaterThanOrEqual(allTools.length - 2);
  }, 120_000);
});
