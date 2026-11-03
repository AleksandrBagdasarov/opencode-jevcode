import { describe, expect, test } from "bun:test";
import { skillQuestion } from "../../src/jev/questions.ts";
import type { Answers, Questions } from "../../src/jev/types.ts";
import { createPromptHook, type PromptEvent } from "../../src/opencode/prompt-hook.ts";
import { createModelRouter, MODEL_QUESTION } from "../../src/router/model-router.ts";
import type { TurnPlan } from "../../src/router/plan.ts";
import {
  buildSkillCatalog,
  capabilityOf,
  chooseSkills,
  createSkillRouter,
  MAX_SKILL_CANDIDATES,
  selectedSkillIds,
  shortlistSkills,
  SKILL_CATALOG_TTL_MS,
  tokenize,
} from "../../src/router/skill-router.ts";
import { createPlanCache, createRestoreMemory, type ModelRef, type StorageLike } from "../../src/state/session-state.ts";

const A: ModelRef = { providerID: "mock", id: "m-small" };

const skill = (id: string, description = "", content = "") => ({ id, name: id, description, autoinvoke: false, path: `/s/${id}`, content });
const skills = (...ids: string[]) => ids.map((id) => skill(id, `${id} helper`));

const noul = (p: number) => ({ kind: "noul" as const, probability: p });

const OPTIONS = { maxSkills: 3, skillThreshold: 0.6, timeoutMs: 200, makeDefault: false, models: [], modelMinConfidence: 0.5 };
const log = { debug() {}, info() {}, warn() {} };

function storage(): StorageLike {
  const data = new Map<string, unknown>();
  return {
    get: async (k) => (data.has(k) ? structuredClone(data.get(k)) : undefined),
    set: async (k, v) => void data.set(k, structuredClone(v)),
    remove: async (k) => void data.delete(k),
  };
}

const MODEL = (id: string) => ({
  providerID: "mock", id, name: id, type: "chat", status: "active", enabled: true,
  capabilities: { tools: true }, limit: { context: 128_000 }, cost: [{ input: 1, output: 5 }], time: { released: 0 },
});

/** A prompt hook with the real model router and skill router over fakes. */
function world(opts: {
  skills?: unknown;
  listFails?: boolean;
  answer?: (q: Questions) => Answers | null;
  agent?: string;
  maxSkills?: number;
  skillThreshold?: number;
} = {}) {
  const asks: Questions[] = [];
  const plans = createPlanCache<TurnPlan>();
  const options = { ...OPTIONS, maxSkills: opts.maxSkills ?? 3, skillThreshold: opts.skillThreshold ?? 0.6 };
  const ctx = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, agent: opts.agent ?? "jevCode", model: { ...A, variant: "default" } }),
      switchModel: async () => {},
    },
  };
  const hook = createPromptHook({
    ctx,
    options,
    log,
    client: {
      ask: async (_state: unknown, q: Questions) => {
        asks.push(q);
        return opts.answer ? opts.answer(q) : null;
      },
    },
    memory: createRestoreMemory(storage(), log),
    plans,
    contributors: [
      createModelRouter({ options, log, listModels: async () => ({ data: ["m-small", "m-big"].map(MODEL) }) }),
      createSkillRouter({
        options,
        log,
        listSkills: async () => {
          if (opts.listFails) throw new Error("list failed");
          return opts.skills ?? { data: [] };
        },
      }),
    ],
  });
  return { asks, plans, hook };
}

const event = (text: string, skills?: unknown[]): PromptEvent => ({
  sessionID: "s1",
  messageID: "msg_1",
  prompt: { text, ...(skills ? { skills } : {}) },
});

describe("skill catalog", () => {
  test("accepts {data} or an array, drops entries without an id, dedupes", () => {
    expect(buildSkillCatalog({ data: [skill("a"), { name: "no id" }, null, skill("a"), skill("b")] }).map((s) => s.id)).toEqual(["a", "b"]);
    expect(buildSkillCatalog([skill("x")])).toHaveLength(1);
    expect(buildSkillCatalog("junk")).toEqual([]);
    expect(buildSkillCatalog(undefined)).toEqual([]);
  });

  test("capability comes from the first prose paragraph, skipping front matter and headings; capped", () => {
    const content = "---\nname: x\n---\n# Title\n\nUse this to write\nunit tests.\n\nSecond paragraph.";
    expect(capabilityOf(content, "")).toBe("Use this to write unit tests.");
    expect(capabilityOf("# only heading", "")).toBe("");
    expect(capabilityOf("same as description", "same as description")).toBe("");
    expect(capabilityOf("x".repeat(5000), "").length).toBe(200);
    expect(capabilityOf(42, "")).toBe("");
  });

  test("capability skips HTML comments (single-line, multi-line, unterminated, after front matter)", () => {
    expect(capabilityOf("<!-- generated -->\n\nWrites unit tests.", "")).toBe("Writes unit tests.");
    expect(capabilityOf("<!--\nmulti\nline\n-->\nWrites unit tests.", "")).toBe("Writes unit tests.");
    expect(capabilityOf("---\nname: x\n---\n<!-- note -->\n# T\n\nWrites unit tests.\n", "")).toBe("Writes unit tests.");
    expect(capabilityOf("Writes <!-- hidden --> tests.", "")).toBe("Writes tests.");
    expect(capabilityOf("<!-- never closed\nWrites unit tests.", "")).toBe("");
  });

  test("skillQuestion is a noul question with metadata only", () => {
    const q = skillQuestion({ name: "git", description: "Git workflows", capability: "commits and rebases" });
    expect(q.kind).toBe("noul");
    expect(q.instructions).toContain("git");
    expect(q.instructions).toContain("Git workflows");
    expect(q.instructions).toContain("commits and rebases");
  });
});

describe("lexical prefilter", () => {
  const many = Array.from({ length: 100 }, (_, i) => buildSkillCatalog([skill(`skill-${i}`, `generic helper number ${i}`)])[0]!);

  test("tokenize lowercases, stems lightly, drops stop words and short words", () => {
    expect([...tokenize("Fixing the Tests, with Docker!")].sort()).toEqual(["docker", "fix", "test"]);
  });

  test("with at most 30 skills all of them are kept", () => {
    expect(shortlistSkills(many.slice(0, 30), "anything")).toHaveLength(30);
    expect(shortlistSkills(many.slice(0, 5), "")).toHaveLength(5);
  });

  test("100 skills are capped at 30 and keep the ones overlapping the prompt", () => {
    const catalog = [...many];
    catalog[77] = buildSkillCatalog([skill("docker-compose", "run containers")])[0]!;
    catalog[88] = buildSkillCatalog([skill("db-migrations", "write sql migration files for postgres")])[0]!;
    const picked = shortlistSkills(catalog, "please fix my docker setup and the postgres migrations");
    expect(picked.length).toBeLessThanOrEqual(MAX_SKILL_CANDIDATES);
    expect(picked.map((s) => s.id)).toContain("docker-compose");
    expect(picked.map((s) => s.id)).toContain("db-migrations");
    // db-migrations: name hit (3) + two description hits (2) beats docker-compose: one name hit (3)
    expect(picked.slice(0, 2).map((s) => s.id)).toEqual(["db-migrations", "docker-compose"]);
  });

  test("every skill overlapping a generic word is capped at 30; nothing overlapping => empty", () => {
    expect(shortlistSkills(many, "need a generic helper")).toHaveLength(30);
    expect(shortlistSkills(many, "zebra quantum")).toEqual([]);
    expect(shortlistSkills(many, "")).toEqual([]);
  });
});

describe("answer selection", () => {
  const allowed = new Set(["a", "b", "c", "d"]);

  test("threshold, order by probability, maxSkills", () => {
    const answers: Answers = { "skill:a": noul(0.7), "skill:b": noul(0.95), "skill:c": noul(0.59), "skill:d": noul(0.8) };
    expect(chooseSkills(answers, allowed, new Set(), 0.6, 2)).toEqual(["b", "d"]);
    expect(chooseSkills(answers, allowed, new Set(), 0.6, 10)).toEqual(["b", "d", "a"]);
    expect(chooseSkills(answers, allowed, new Set(), 0.9, 10)).toEqual(["b"]);
    expect(chooseSkills(answers, allowed, new Set(), 0.6, 0)).toEqual([]);
  });

  test("hostile answers: unknown ids, wrong kinds, NaN, null", () => {
    const answers = {
      "skill:evil": noul(1),
      "skill:../../etc": noul(1),
      "skill:a": { kind: "choice", choice: "a", confidence: 1, probabilities: {} },
      "skill:b": noul(Number.NaN),
      "skill:c": { kind: "error", reason: "x" },
      "skill:d": noul(7), // clamped to 1
      model: noul(1),
    } as unknown as Answers;
    expect(chooseSkills(answers, allowed, new Set(), 0.6, 5)).toEqual(["d"]);
    expect(chooseSkills(null, allowed, new Set(), 0.6, 5)).toEqual([]);
    expect(chooseSkills({}, allowed, new Set(), 0.6, 5)).toEqual([]);
  });

  test("skills already selected are excluded", () => {
    const answers: Answers = { "skill:a": noul(0.9), "skill:b": noul(0.8) };
    expect(chooseSkills(answers, allowed, new Set(["a"]), 0.6, 5)).toEqual(["b"]);
  });

  test("selectedSkillIds reads {id} objects and strings, tolerates junk", () => {
    expect([...selectedSkillIds([{ id: "a", mention: "@a" }, "b", { id: 3 }, null, {}])].sort()).toEqual(["a", "b"]);
    expect(selectedSkillIds(undefined).size).toBe(0);
  });
});

describe("skill router in the prompt hook", () => {
  const answerAll = (p: number) => (q: Questions): Answers => {
    const out: Answers = {};
    for (const name of Object.keys(q)) out[name] = name === MODEL_QUESTION ? { kind: "choice", choice: "keep", confidence: 0.9, probabilities: {} } : noul(p);
    return out;
  };

  test("selected skills are pushed as {id} objects; model + skill questions go in ONE ask", async () => {
    const w = world({ skills: { data: skills("git", "docker", "sql") }, answer: answerAll(0.9) });
    const ev = event("rewrite git history");
    await w.hook(ev);
    expect(w.asks).toHaveLength(1);
    expect(Object.keys(w.asks[0]!).sort()).toEqual(["model", "skill:docker", "skill:git", "skill:sql"]);
    expect(ev.prompt!.skills).toEqual([{ id: "git" }, { id: "docker" }, { id: "sql" }]);
    expect(w.plans.get("s1")?.skills).toEqual(["git", "docker", "sql"]);
    expect(w.plans.get("s1")?.source).toBe("jev");
  });

  test("hostile answers: ids that are not in ctx.skill.list() are never added", async () => {
    const w = world({
      skills: skills("git"),
      answer: () => ({ "skill:git": noul(0.9), "skill:rm-rf": noul(1), "skill:": noul(1), "skill:__proto__": noul(1) }),
    });
    const ev = event("use git");
    await w.hook(ev);
    expect(ev.prompt!.skills).toEqual([{ id: "git" }]);
  });

  test("maxSkills and skillThreshold are honoured", async () => {
    const answer = (q: Questions): Answers => ({
      "skill:a": noul(0.7), "skill:b": noul(0.95), "skill:c": noul(0.5), "skill:d": noul(0.8),
      ...(MODEL_QUESTION in q ? {} : {}),
    });
    const w = world({ skills: skills("a", "b", "c", "d"), answer, maxSkills: 2, skillThreshold: 0.6 });
    const ev = event("do things");
    await w.hook(ev);
    expect(ev.prompt!.skills).toEqual([{ id: "b" }, { id: "d" }]);
  });

  test("no duplicates when the user already selected a skill; it gets no question", async () => {
    const w = world({ skills: skills("git", "docker"), answer: answerAll(0.95) });
    const ev = event("git and docker", [{ id: "git", mention: "@git" }]);
    await w.hook(ev);
    expect(Object.keys(w.asks[0]!)).not.toContain("skill:git");
    expect(ev.prompt!.skills).toEqual([{ id: "git", mention: "@git" }, { id: "docker" }]);
    expect(w.plans.get("s1")?.skills).toEqual(["docker"]);
  });

  test("100 skills: at most 30 skill questions in the single request", async () => {
    const list = Array.from({ length: 100 }, (_, i) => skill(`s${i}`, "common helper text"));
    const w = world({ skills: list, answer: () => null });
    await w.hook(event("need a common helper"));
    expect(w.asks).toHaveLength(1);
    expect(Object.keys(w.asks[0]!).filter((k) => k.startsWith("skill:"))).toHaveLength(30);
  });

  test("zero skills: no skill questions and the prompt is untouched", async () => {
    const w = world({ skills: { data: [] }, answer: answerAll(1) });
    const ev = event("hello");
    await w.hook(ev);
    expect(Object.keys(w.asks[0]!)).toEqual(["model"]);
    expect(ev.prompt!.skills).toBeUndefined();
  });

  test("Jev failure leaves the prompt untouched", async () => {
    const w = world({ skills: skills("git"), answer: () => null });
    const ev = event("use git", []);
    await w.hook(ev);
    expect(w.asks).toHaveLength(1);
    expect(ev.prompt!.skills).toEqual([]);
    expect(w.plans.get("s1")?.source).toBe("fallback");
    expect(w.plans.get("s1")?.skills).toEqual([]);
  });

  test("skills below the threshold: prompt untouched, no skills key created", async () => {
    const w = world({ skills: skills("git"), answer: () => ({ "skill:git": noul(0.1) }) });
    const ev = event("use git");
    await w.hook(ev);
    expect(ev.prompt!.skills).toBeUndefined();
  });

  test("skill listing failure: skipped, model question still asked, never throws", async () => {
    const w = world({ listFails: true, answer: answerAll(1) });
    const ev = event("use git");
    await expect(w.hook(ev)).resolves.toBeUndefined();
    expect(Object.keys(w.asks[0]!)).toEqual(["model"]);
    expect(ev.prompt!.skills).toBeUndefined();
  });

  test("maxSkills 0 disables skill routing", async () => {
    const w = world({ skills: skills("git"), answer: answerAll(1), maxSkills: 0 });
    const ev = event("use git");
    await w.hook(ev);
    expect(Object.keys(w.asks[0]!)).toEqual(["model"]);
    expect(ev.prompt!.skills).toBeUndefined();
  });

  test("a skill-only decision makes the plan source jev even when the model is kept", async () => {
    const w = world({ skills: skills("git"), answer: () => ({ "skill:git": noul(0.9) }) });
    await w.hook(event("use git"));
    expect(w.plans.get("s1")?.source).toBe("jev");
    expect(w.plans.get("s1")?.model).toBeUndefined();
  });

  test("isolation: non-jev agents never get skills, zero asks, no list call", async () => {
    for (const agent of ["build", "plan", "jevCode2", "JevCode"]) {
      const w = world({ agent, skills: skills("git"), answer: answerAll(1) });
      const ev = event("use git", []);
      await w.hook(ev);
      expect(w.asks).toHaveLength(0);
      expect(ev.prompt!.skills).toEqual([]);
      expect(w.plans.get("s1")).toBeUndefined();
    }
  });
});

describe("skill router contributor", () => {
  const input = (text: string, prompt: PromptEvent["prompt"] = {}) => ({
    sessionID: "s1", turnKey: "k", text, current: A, prompt: prompt ?? {},
  });

  test("catalog is cached for the TTL and refreshed after it", async () => {
    let calls = 0;
    let t = 0;
    const r = createSkillRouter({ options: OPTIONS, log, listSkills: async () => (calls++, skills("git")), now: () => t });
    await r.prepare(input("git"));
    await r.prepare(input("git"));
    expect(calls).toBe(1);
    t = SKILL_CATALOG_TTL_MS + 1;
    await r.prepare(input("git"));
    expect(calls).toBe(2);
  });

  test("a hung skill.list times out and skips", async () => {
    const r = createSkillRouter({ options: { ...OPTIONS, timeoutMs: 30 }, log, listSkills: () => new Promise(() => {}) });
    const started = Date.now();
    const res = await r.prepare(input("git"));
    expect(Date.now() - started).toBeLessThan(500);
    expect(res).toEqual({ skip: "skill catalog unavailable" });
  });

  test("a synchronous throw in listSkills is a skip", async () => {
    const r = createSkillRouter({ options: OPTIONS, log, listSkills: () => { throw new Error("boom"); } });
    expect(await r.prepare(input("git"))).toEqual({ skip: "skill catalog unavailable" });
  });

  test("empty prompt and no-match skip paths", async () => {
    const r = createSkillRouter({ options: OPTIONS, log, listSkills: async () => skills("git") });
    expect(await r.prepare(input("   "))).toEqual({ skip: "empty prompt" });
    const none = createSkillRouter({ options: OPTIONS, log, listSkills: async () => [] });
    expect(await none.prepare(input("git"))).toEqual({ skip: "no skills installed" });
  });

  test("apply with null answers or a skill chosen after the user attached it changes nothing", async () => {
    const r = createSkillRouter({ options: OPTIONS, log, listSkills: async () => skills("git", "sql") });
    const prompt: { text: string; skills?: unknown[] } = { text: "x" };
    const prepared = await r.prepare(input("git sql", prompt));
    if ("skip" in prepared) throw new Error("unexpected skip");
    const plan = { skills: [] } as unknown as TurnPlan;
    expect((await prepared.apply(null, plan)).decided).toBe(false);
    // the user attaches git between prepare and apply
    prompt.skills = [{ id: "git" }];
    const out = await prepared.apply({ "skill:git": noul(1), "skill:sql": noul(0.9) }, plan);
    expect(out.decided).toBe(true);
    expect(prompt.skills).toEqual([{ id: "git" }, { id: "sql" }]);
    expect(plan.skills).toEqual(["sql"]);
  });
});
