import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyJevAgent,
  JEV_AGENT_ID,
  JEV_COLOR,
  JEV_DESCRIPTION,
  JEV_SYSTEM_PROMPT,
  parseModelKey,
  renderAgentMarkdown,
  type AgentDraft,
} from "../src/agent/definition.ts";
import { PACKAGED_AGENT_FILE, registerAgent, type AgentCtx, type AgentEditorLike } from "../src/agent/register.ts";
import { createLogger } from "../src/log.ts";
import { resolveOptions } from "../src/config.ts";

type Rule = NonNullable<AgentDraft["permissions"]>[number];

const BUILD_PERMISSIONS: Rule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "question", resource: "*", effect: "ask" },
  { action: "read", resource: "*.env", effect: "deny" },
];

/** Fake of the host AgentEditor: `update` upserts, like OpenCode 2.2.5 (design F2). */
class FakeEditor implements AgentEditorLike {
  agents = new Map<string, AgentDraft>();
  defaultId: string | undefined;
  constructor(seed: Record<string, AgentDraft> = {}) {
    for (const [id, a] of Object.entries(seed)) this.agents.set(id, a);
  }
  get(id: string) {
    return this.agents.get(id);
  }
  update(id: string, fn: (a: AgentDraft) => void) {
    const draft = this.agents.get(id) ?? { mode: "primary", permissions: [{ action: "*", resource: "*", effect: "ask" }] };
    fn(draft);
    this.agents.set(id, draft);
  }
  default(id: string | undefined) {
    this.defaultId = id;
  }
}

interface FakeCtxOptions {
  editor?: FakeEditor;
  /** Whether the host lists the agent after the transform (false simulates a broken upsert). */
  listsAgent?: boolean;
  listImpl?: () => Promise<unknown>;
  transformImpl?: AgentCtx["agent"]["transform"];
  directory?: string;
}

function fakeCtx(o: FakeCtxOptions = {}) {
  const editor = o.editor ?? new FakeEditor({ build: { mode: "primary", permissions: BUILD_PERMISSIONS } });
  const callbacks: Array<(e: AgentEditorLike) => void> = [];
  let disposed = 0;
  const ctx: AgentCtx = {
    location: { directory: o.directory ?? tmpdir() },
    agent: {
      transform:
        o.transformImpl ??
        (async (cb) => {
          callbacks.push(cb);
          cb(editor);
          return { dispose: async () => void disposed++ };
        }),
      list: o.listImpl ?? (async () => ({ location: {}, data: (o.listsAgent ?? true) ? [{ id: "build" }, { id: JEV_AGENT_ID }] : [{ id: "build" }] })),
    },
  };
  return { ctx, editor, callbacks, disposed: () => disposed };
}

function logs(options: unknown = {}) {
  const lines: string[] = [];
  const log = createLogger({ debug: true, sink: (l) => lines.push(l) });
  return { log, lines, options: resolveOptions(options, {}) };
}

describe("definition", () => {
  test("applyJevAgent sets description, mode, system, color", () => {
    const d: AgentDraft = {};
    applyJevAgent(d, {});
    expect(d.description).toBe(JEV_DESCRIPTION);
    expect(d.mode).toBe("primary");
    expect(d.system).toBe(JEV_SYSTEM_PROMPT);
    expect(d.color).toBe(JEV_COLOR);
    expect(d.model).toBeUndefined();
    expect(JEV_SYSTEM_PROMPT).toContain("Do not assume that tools or skills unavailable in the current request are available.");
  });

  test("agentModel maps provider/id[#variant] (id may contain slashes)", () => {
    expect(parseModelKey("anthropic/claude-x")).toEqual({ providerID: "anthropic", id: "claude-x" });
    expect(parseModelKey("openrouter/anthropic/claude-x#high")).toEqual({ providerID: "openrouter", id: "anthropic/claude-x", variant: "high" });
    expect(parseModelKey("nope")).toBeUndefined();
    expect(parseModelKey("a/")).toBeUndefined();
    expect(parseModelKey(undefined)).toBeUndefined();
    const d: AgentDraft = {};
    applyJevAgent(d, { agentModel: "openai/gpt-x#fast" });
    expect(d.model).toEqual({ providerID: "openai", id: "gpt-x", variant: "fast" });
  });

  test("permissions are a deep copy of build's (equal, not the same objects)", () => {
    const build = { permissions: BUILD_PERMISSIONS };
    const d: AgentDraft = { permissions: [{ action: "*", resource: "*", effect: "allow" }] };
    applyJevAgent(d, {}, build);
    expect(d.permissions).toEqual(BUILD_PERMISSIONS);
    expect(d.permissions).not.toBe(BUILD_PERMISSIONS);
    d.permissions![0]!.effect = "allow";
    d.permissions![1]!.effect = "allow";
    expect(BUILD_PERMISSIONS[1]!.effect).toBe("ask");
  });

  test("without build the default permissions are left untouched (never invented)", () => {
    const original: Rule[] = [{ action: "*", resource: "*", effect: "ask" }];
    const d: AgentDraft = { permissions: original };
    applyJevAgent(d, {});
    expect(d.permissions).toBe(original);
  });

  test("agents/jevCode.md equals the rendering of the in-plugin definition (no drift)", () => {
    const file = readFileSync(PACKAGED_AGENT_FILE, "utf8").replace(/\r\n/g, "\n");
    expect(file).toBe(renderAgentMarkdown());
    const m = /^---\n([\s\S]*?)\n---\n\n([\s\S]*?)\n?$/.exec(file);
    expect(m).not.toBeNull();
    expect(m![1]).toContain(`description: ${JEV_DESCRIPTION}`);
    expect(m![1]).toContain("mode: primary");
    expect(m![2]!.trim()).toBe(JEV_SYSTEM_PROMPT);
  });
});

describe("registerAgent", () => {
  test("creates jevCode via editor.update with build's permissions deep-equal", async () => {
    const { ctx, editor } = fakeCtx();
    const { log, options } = logs();
    await registerAgent(ctx, { options, log });
    const jev = editor.agents.get(JEV_AGENT_ID)!;
    expect(jev.mode).toBe("primary");
    expect(jev.system).toBe(JEV_SYSTEM_PROMPT);
    expect(jev.permissions).toEqual(editor.agents.get("build")!.permissions!);
    expect(jev.permissions).not.toBe(editor.agents.get("build")!.permissions);
  });

  test("build is not modified", async () => {
    const { ctx, editor } = fakeCtx();
    const before = JSON.stringify(editor.agents.get("build"));
    const { log, options } = logs({ makeDefault: true, agentModel: "a/b" });
    await registerAgent(ctx, { options, log });
    expect(JSON.stringify(editor.agents.get("build"))).toBe(before);
  });

  test("the transform callback is idempotent: running it twice yields one identical definition", async () => {
    const { ctx, editor, callbacks } = fakeCtx();
    const { log, options } = logs({ agentModel: "openai/gpt-x" });
    await registerAgent(ctx, { options, log });
    const once = JSON.stringify([...editor.agents.entries()]);
    callbacks[0]!(editor);
    callbacks[0]!(editor);
    expect(JSON.stringify([...editor.agents.entries()])).toBe(once);
    expect([...editor.agents.keys()].filter((k) => k === JEV_AGENT_ID)).toHaveLength(1);
  });

  test("makeDefault calls editor.default only when enabled", async () => {
    const a = fakeCtx();
    const la = logs();
    await registerAgent(a.ctx, { options: la.options, log: la.log });
    expect(a.editor.defaultId).toBeUndefined();

    const b = fakeCtx();
    const lb = logs({ makeDefault: true });
    await registerAgent(b.ctx, { options: lb.options, log: lb.log });
    expect(b.editor.defaultId).toBe(JEV_AGENT_ID);
  });

  test("works when build is absent (host defaults kept)", async () => {
    const { ctx, editor } = fakeCtx({ editor: new FakeEditor() });
    const { log, options } = logs();
    await registerAgent(ctx, { options, log });
    expect(editor.agents.get(JEV_AGENT_ID)!.permissions).toEqual([{ action: "*", resource: "*", effect: "ask" }]);
  });

  test("returned Disposable disposes the transform registration", async () => {
    const { ctx, disposed } = fakeCtx();
    const { log, options } = logs();
    const d = await registerAgent(ctx, { options, log });
    await d.dispose();
    expect(disposed()).toBe(1);
  });

  test("a throwing editor inside the transform is logged, not thrown", async () => {
    const editor = new FakeEditor();
    editor.update = () => {
      throw new Error("editor exploded");
    };
    const { ctx } = fakeCtx({ editor });
    const { log, options, lines } = logs();
    await expect(registerAgent(ctx, { options, log })).resolves.toBeDefined();
    expect(lines.join("\n")).toContain("editor exploded");
  });

  test("a rejecting agent.transform is logged and the canary still runs; nothing throws", async () => {
    const { ctx } = fakeCtx({
      transformImpl: async () => {
        throw new Error("transform unavailable");
      },
      listsAgent: false,
    });
    const { log, options, lines } = logs();
    const d = await registerAgent(ctx, { options, log });
    await expect(d.dispose()).resolves.toBeUndefined();
    const out = lines.join("\n");
    expect(out).toContain("transform unavailable");
    expect(out).toContain("NOT in the agent list");
  });
});

describe("canary and file fallback", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jev-agent-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const target = () => join(dir, ".opencode", "agents", "jevCode.md");

  test("present agent: no error, no file", async () => {
    const { ctx } = fakeCtx({ directory: dir });
    const { log, options, lines } = logs({ agentFileFallback: true });
    await registerAgent(ctx, { options, log });
    expect(lines.some((l) => l.includes("error:"))).toBe(false);
    expect(existsSync(target())).toBe(false);
  });

  test("missing agent logs a clear error and does not throw; no file unless agentFileFallback", async () => {
    const { ctx } = fakeCtx({ directory: dir, listsAgent: false });
    const { log, options, lines } = logs();
    await expect(registerAgent(ctx, { options, log })).resolves.toBeDefined();
    const out = lines.join("\n");
    expect(out).toContain("error:");
    expect(out).toContain("jevCode agent is NOT in the agent list");
    expect(out).toContain("agents/jevCode.md");
    expect(existsSync(target())).toBe(false);
  });

  test("agentFileFallback writes the packaged file, creating folders", async () => {
    const { ctx } = fakeCtx({ directory: dir, listsAgent: false });
    const { log, options } = logs({ agentFileFallback: true });
    await registerAgent(ctx, { options, log });
    expect(readFileSync(target(), "utf8")).toBe(readFileSync(PACKAGED_AGENT_FILE, "utf8"));
  });

  test("agentFileFallback never overwrites an existing file", async () => {
    mkdirSync(join(dir, ".opencode", "agents"), { recursive: true });
    writeFileSync(target(), "my own agent");
    const { ctx } = fakeCtx({ directory: dir, listsAgent: false });
    const { log, options, lines } = logs({ agentFileFallback: true });
    await registerAgent(ctx, { options, log });
    expect(readFileSync(target(), "utf8")).toBe("my own agent");
    expect(lines.join("\n")).toContain("already exists");
  });

  test("agent.list rejecting is a warning, never a throw, and writes nothing", async () => {
    const { ctx } = fakeCtx({
      directory: dir,
      listImpl: async () => {
        throw new Error("list down");
      },
    });
    const { log, options, lines } = logs({ agentFileFallback: true });
    await expect(registerAgent(ctx, { options, log })).resolves.toBeDefined();
    expect(lines.join("\n")).toContain("list down");
    expect(existsSync(target())).toBe(false);
  });

  test("agent.list timing out is tolerated", async () => {
    const { ctx } = fakeCtx({ directory: dir, listImpl: () => new Promise(() => {}) });
    const { log, options, lines } = logs();
    await expect(registerAgent(ctx, { options, log, canaryTimeoutMs: 20 })).resolves.toBeDefined();
    expect(lines.join("\n")).toContain("timed out");
  });

  test("a bare-array list response is understood", async () => {
    const { ctx } = fakeCtx({ directory: dir, listImpl: async () => [{ id: JEV_AGENT_ID }] });
    const { log, options, lines } = logs();
    await registerAgent(ctx, { options, log });
    expect(lines.some((l) => l.includes("error:"))).toBe(false);
  });

  test("an unwritable target is logged, not thrown", async () => {
    // A FILE named .opencode makes mkdir fail.
    writeFileSync(join(dir, ".opencode"), "x");
    const { ctx } = fakeCtx({ directory: dir, listsAgent: false });
    const { log, options, lines } = logs({ agentFileFallback: true });
    await expect(registerAgent(ctx, { options, log })).resolves.toBeDefined();
    expect(lines.join("\n")).toContain("could not write the fallback agent file");
  });
});
