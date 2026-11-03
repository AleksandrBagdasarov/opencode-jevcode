/**
 * End-to-end check of context relevance pruning (ticket 0007) against the REAL `opencode` binary with a mock
 * OpenAI-compatible provider and a mock TypeSafe (Jev) endpoint. Skipped unless OPENCODE_INTEGRATION=1:
 *
 *   $env:OPENCODE_INTEGRATION=1; bun test tests/integration/context-prune.int.test.ts
 *
 * One session, several turns (`run --continue`). Evidence asserted on opencode 2.2.5:
 *  - the first turn (one message) makes no stage-B request;
 *  - a later jevCode turn makes exactly ONE `unit:*` score request and, when Jev scores the old units 0, the model
 *    request no longer contains the old topics but still has the latest user message;
 *  - the next turn, with Jev keeping everything, sends the old topics again (the persisted history was not touched);
 *  - a `build` turn makes zero Jev requests and sends the whole history.
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
  hasTools: boolean;
  text: string;
}
interface JevRequest {
  body: { state?: any; questions?: Record<string, { type?: string }> };
}

describe.skipIf(!enabled)("context pruning on the real opencode binary", () => {
  let base: string;
  let modelServer: ReturnType<typeof Bun.serve>;
  let jevServer: ReturnType<typeof Bun.serve>;
  let isolatedEnv: Record<string, string> = {};
  const modelRequests: ModelRequest[] = [];
  const jevRequests: JevRequest[] = [];
  let unitScore = 0;

  async function run(agent: string, message: string, cont: boolean) {
    const bin = Bun.which("opencode");
    if (!bin) throw new Error("opencode binary not found on PATH");
    modelRequests.length = 0;
    jevRequests.length = 0;
    const args = ["--standalone", "run", "--agent", agent, "--model", "mock/m-small", ...(cont ? ["--continue"] : []), message];
    const proc = Bun.spawn([bin, ...args], {
      cwd: base,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...isolatedEnv, JEVCODE_TEST_MOCK_BASE_URL: `http://127.0.0.1:${modelServer.port}/v1` },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) console.log(`opencode exited with ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr.slice(-3000)}`);
    const agentRequests = modelRequests.filter((r) => r.hasTools);
    const unitRequests = jevRequests.filter((j) => Object.keys(j.body.questions ?? {}).some((n) => n.startsWith("unit:")));
    return { code, agentRequests, jev: [...jevRequests], unitRequests };
  }

  beforeAll(() => {
    modelServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "m-small" }, { id: "m-mid" }, { id: "m-big" }] });
        const body = (await req.json().catch(() => ({}))) as { model?: string; stream?: boolean; tools?: unknown[]; messages?: unknown[] };
        modelRequests.push({
          model: String(body.model),
          hasTools: (body.tools ?? []).length > 0,
          text: JSON.stringify((body.messages ?? []).filter((m: any) => m.role !== "system")),
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
          else if (name.startsWith("unit:")) answers[name] = { type: "score", score: unitScore, confidence: 0.9 };
          else if (name.startsWith("tools:")) answers[name] = { type: "noul", noul: 0.9 };
          else if (q.type === "noul") answers[name] = { type: "noul", noul: 0.05 };
          else answers[name] = { type: "score", score: 0, confidence: 0.5 };
        }
        return Response.json({ answers });
      },
    });

    base = mkdtempSync(join(tmpdir(), "jev-e2e-prune-"));
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
            pruneMinTokens: 1,
            keepRecentMessages: 1,
            keepFirstUser: false,
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

  test("turn 1: a single message has nothing to prune (no stage-B request)", async () => {
    unitScore = 0;
    const r = await run("jevCode", "alpha first topic", false);
    expect(r.code).toBe(0);
    expect(r.unitRequests).toHaveLength(0);
    expect(r.agentRequests.length).toBeGreaterThan(0);
    expect(r.agentRequests[0]!.text).toContain("alpha first topic");
  }, 120_000);

  test("turn 2 (Jev: old unit irrelevant): exactly one score request; the old topic is not sent, the new one is", async () => {
    unitScore = 0;
    await run("jevCode", "beta second topic", true);
    const r = await run("jevCode", "gamma third topic", true);
    console.log("E2E prune: unit questions:", r.unitRequests.map((j) => Object.keys(j.body.questions!)));
    expect(r.code).toBe(0);
    expect(r.unitRequests).toHaveLength(1);
    const names = Object.keys(r.unitRequests[0]!.body.questions!);
    for (const n of names) expect(n.startsWith("unit:")).toBe(true);
    expect(r.unitRequests[0]!.body.state.currentRequest).toContain("gamma third topic");
    expect(r.agentRequests.length).toBeGreaterThan(0);
    for (const req of r.agentRequests) {
      expect(req.text).toContain("gamma third topic");
      expect(req.text).not.toContain("alpha first topic");
      expect(req.text).not.toContain("beta second topic");
    }
  }, 240_000);

  test("next turn (Jev: everything relevant): the old topics are sent again, so history was never modified", async () => {
    unitScore = 4;
    const r = await run("jevCode", "delta fourth topic", true);
    expect(r.code).toBe(0);
    expect(r.unitRequests).toHaveLength(1);
    expect(r.agentRequests.length).toBeGreaterThan(0);
    for (const req of r.agentRequests) {
      expect(req.text).toContain("delta fourth topic");
      expect(req.text).toContain("alpha first topic");
      expect(req.text).toContain("gamma third topic");
    }
  }, 120_000);

  test("build agent on the same session: zero Jev requests and the whole history is sent", async () => {
    unitScore = 0;
    const r = await run("build", "epsilon fifth topic", true);
    expect(r.code).toBe(0);
    expect(r.jev).toHaveLength(0);
    expect(r.agentRequests.length).toBeGreaterThan(0);
    expect(r.agentRequests[0]!.text).toContain("alpha first topic");
    expect(r.agentRequests[0]!.text).toContain("epsilon fifth topic");
  }, 120_000);
});
