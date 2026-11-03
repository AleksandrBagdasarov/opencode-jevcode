/**
 * End-to-end check of stage A against the REAL `opencode` binary with a mock OpenAI-compatible model
 * provider and a mock TypeSafe (Jev) endpoint (ticket 0004, AC 1 and 7). Skipped unless
 * OPENCODE_INTEGRATION=1:
 *
 *   $env:OPENCODE_INTEGRATION=1; bun test tests/integration/prompt-hook.int.test.ts
 *
 * Evidence asserted:
 *  - jevCode prompt, Jev chooses mock/m-big while the run starts on mock/m-small: the Jev request is the
 *    batched `choice` question, and EVERY model request of that prompt (title + agent) used m-big, i.e.
 *    switchModel inside the prompt hook worked and took effect for the same prompt;
 *  - a `build` prompt makes zero Jev requests and keeps the requested model;
 *  - a failing Jev keeps the requested model (fail open).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const enabled = process.env.OPENCODE_INTEGRATION === "1";
const repoRoot = resolve(import.meta.dir, "..", "..");
const fixture = resolve(import.meta.dir, "fixtures", "mock-provider.plugin.ts");

interface ModelRequest {
  url: string;
  model: string;
  tools: number;
  /** Raw JSON request body (to look for injected skill content). */
  raw: string;
}
interface JevRequest {
  auth: string | null;
  body: { model?: string; state?: any; questions?: Record<string, any> };
}

describe.skipIf(!enabled)("stage A on the real opencode binary (mock provider + mock Jev)", () => {
  let base: string;
  let modelServer: ReturnType<typeof Bun.serve>;
  let jevServer: ReturnType<typeof Bun.serve>;
  const modelRequests: ModelRequest[] = [];
  const jevRequests: JevRequest[] = [];
  let jevMode: "choose-big" | "fail" = "choose-big";
  /** Isolated HOME/XDG dirs so the user's global skills/config do not leak into the run. */
  let isolatedEnv: Record<string, string> = {};
  /** Project-local skill: Jev answers it with a high noul, every other skill with a low one. */
  const SKILL_ID = "jev-e2e-skill";
  const SKILL_MARKER = "JEV-E2E-SKILL-MARKER-7Q2X";

  /** Model stored on the most recent session of the temp project (`/api/session`). */
  async function latestSessionModel(): Promise<string> {
    const bin = Bun.which("opencode")!;
    const proc = Bun.spawn([bin, "--standalone", "api", "get", "/api/session"], { cwd: base, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...isolatedEnv } });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const sessions = (JSON.parse(out).data as Array<{ model?: { providerID: string; id: string }; location?: { directory?: string }; time: { updated: number } }>)
      .filter((s) => s.location?.directory?.toLowerCase() === base.toLowerCase())
      .sort((a, b) => b.time.updated - a.time.updated);
    const m = sessions[0]?.model;
    return m ? `${m.providerID}/${m.id}` : "none";
  }

  async function run(agent: string, startModel: string | undefined, message: string, extra: string[] = []) {
    const bin = Bun.which("opencode");
    if (!bin) throw new Error("opencode binary not found on PATH");
    modelRequests.length = 0;
    jevRequests.length = 0;
    const model = startModel ? ["--model", startModel] : [];
    const proc = Bun.spawn([bin, "--standalone", "run", ...extra, "--agent", agent, ...model, message], {
      cwd: base,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...isolatedEnv, JEVCODE_TEST_MOCK_BASE_URL: `http://127.0.0.1:${modelServer.port}/v1` },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) console.log(`opencode exited with ${code}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr.slice(-3000)}`);
    return { stdout, stderr, code, models: modelRequests.map((r) => r.model), jev: [...jevRequests] };
  }

  beforeAll(() => {
    modelServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "m-small" }, { id: "m-mid" }, { id: "m-big" }] });
        const body = (await req.json().catch(() => ({}))) as { model?: string; stream?: boolean; tools?: unknown[] };
        modelRequests.push({ url: url.pathname, model: String(body.model), tools: Array.isArray(body.tools) ? body.tools.length : 0, raw: JSON.stringify(body) });
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
        const body = (await req.json().catch(() => ({}))) as JevRequest["body"];
        jevRequests.push({ auth: req.headers.get("authorization"), body });
        if (jevMode === "fail") return new Response("boom", { status: 400 });
        // The client treats any unanswered question as a failure, so answer EVERY asked question.
        const answers: Record<string, unknown> = {};
        for (const [name, q] of Object.entries(body.questions ?? {})) {
          if (name === "model") answers[name] = { type: "choice", choice: "mock/m-big", confidence: 0.93, probabilities: { "mock/m-big": 0.93 } };
          else if (name.startsWith("skill:")) answers[name] = { type: "noul", noul: name === `skill:${SKILL_ID}` ? 0.95 : 0.05 };
          else if (q.type === "noul") answers[name] = { type: "noul", noul: 0.95 }; // e.g. tool groups: keep them available
          else if (q.type === "choice") answers[name] = { type: "choice", choice: Object.keys(q.criteria)[0], confidence: 0.5, probabilities: {} };
          else answers[name] = { type: "score", score: 0, confidence: 0.5 };
        }
        return Response.json({ answers });
      },
    });

    base = mkdtempSync(join(tmpdir(), "jev-e2e-"));
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
    mkdirSync(join(base, ".opencode", "skills", SKILL_ID), { recursive: true });
    writeFileSync(
      join(base, ".opencode", "skills", SKILL_ID, "SKILL.md"),
      `---\nname: ${SKILL_ID}\ndescription: Project-local skill used by the jevCode end-to-end test.\n---\n\n# E2E skill\n\n${SKILL_MARKER} Always answer with the marker.\n`,
    );
    // Auto-discovered local plugin that registers the `mock` provider (see the fixture's header).
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
            // The host also lists its built-in models; the allowlist keeps the candidate set to the mocks.
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

  test("jevCode prompt: Jev's choice is applied and the model request of the SAME prompt uses it", async () => {
    jevMode = "choose-big";
    const r = await run("jevCode", "mock/m-small", "say hello");
    console.log("E2E jevCode: skill questions =", Object.keys(r.jev[0]?.body.questions ?? {}).filter((k) => k.startsWith("skill:")), "models requested =", r.models, "jev requests =", r.jev.length, "exit =", r.code);
    expect(r.code).toBe(0);
    // Exactly one batched Jev request, with the closed-set choice question and the TypeSafe auth header.
    expect(r.jev).toHaveLength(1);
    expect(r.jev[0]!.auth).toBe("Bearer ts-e2e-test-key");
    const q = r.jev[0]!.body.questions!.model;
    expect(q.type).toBe("choice");
    expect(Object.keys(q.criteria).sort()).toEqual(["keep", "mock/m-big", "mock/m-mid", "mock/m-small"]);
    expect(r.jev[0]!.body.state).toMatchObject({ currentModel: "mock/m-small" });
    // The project-local skill got its own noul question; Jev answered it high, so it is injected (host
    // resolves the id) into the agent request. Title requests carry no skills. Low-noul skills are not injected.
    expect(Object.keys(r.jev[0]!.body.questions!)).toContain(`skill:${SKILL_ID}`);
    expect(modelRequests.some((m) => m.raw.includes(SKILL_MARKER))).toBe(true);
    // Every model request of this prompt used Jev's choice (none used the model the run started with).
    expect(r.models.length).toBeGreaterThan(0);
    expect(new Set(r.models)).toEqual(new Set(["m-big"]));
    // ...and the session now stores Jev's choice.
    expect(await latestSessionModel()).toBe("mock/m-big");
  }, 120_000);

  test("switching to build afterwards restores the model from before routing (R1.5)", async () => {
    jevMode = "choose-big";
    // `--continue` re-opens the session of the previous test (jevCode, now on m-big).
    const r = await run("build", undefined, "again", ["--continue"]);
    console.log("E2E restore: models requested =", r.models, "jev requests =", r.jev.length, "exit =", r.code);
    expect(r.code).toBe(0);
    expect(r.jev).toHaveLength(0);
    expect(await latestSessionModel()).toBe("mock/m-small");
    expect(new Set(r.models)).toEqual(new Set(["m-small"]));
  }, 120_000);

  test("a build prompt: zero Jev requests, the requested model is used", async () => {
    jevMode = "choose-big";
    const r = await run("build", "mock/m-small", "say hello");
    console.log("E2E build: models requested =", r.models, "jev requests =", r.jev.length, "exit =", r.code);
    expect(r.code).toBe(0);
    expect(r.jev).toHaveLength(0);
    expect(r.models.length).toBeGreaterThan(0);
    expect(new Set(r.models)).toEqual(new Set(["m-small"]));
  }, 120_000);

  test("Jev failing: jevCode keeps the requested model (fail open)", async () => {
    jevMode = "fail";
    const r = await run("jevCode", "mock/m-mid", "say hello");
    console.log("E2E jev down: models requested =", r.models, "jev requests =", r.jev.length, "exit =", r.code);
    expect(r.code).toBe(0);
    expect(r.jev.length).toBeGreaterThanOrEqual(1);
    expect(new Set(r.models)).toEqual(new Set(["m-mid"]));
  }, 120_000);
});
