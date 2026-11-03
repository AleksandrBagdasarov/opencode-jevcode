import { describe, expect, test } from "bun:test";
import { collectActiveFiles, collectCompletedWork, collectUnresolvedIssues, filesOfInput } from "../../src/context/collector.ts";
import { distill, DISTILL_MAX_CHARS } from "../../src/context/distiller.ts";
import { conversationTokens, findOrphans, groupMessages, SUMMARY_MAX_CHARS } from "../../src/context/message-groups.ts";
import { analyze, applyDrop } from "../../src/context/prune.ts";
import { contextBudget, estimateTokens, fitToBudget } from "../../src/context/token-budget.ts";
import { callPart, assistantText, deepFreeze, resultPart, textPart, userMsg } from "./gen.ts";

const toolMsg = (...parts: unknown[]) => ({ role: "tool", content: parts });
const assistantCalls = (...parts: unknown[]) => ({ role: "assistant", content: parts });

describe("token budget", () => {
  test("estimates are chars / 4 rounded up and never throw", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens({ a: "x".repeat(100) })).toBeGreaterThan(25);
    const circular: any = {};
    circular.self = circular;
    expect(estimateTokens(circular)).toBeGreaterThan(0);
  });

  test("budget is min(plan.maxTokens, model context * 0.6); unknown values are ignored", () => {
    expect(contextBudget(50_000, 100_000)).toBe(50_000);
    expect(contextBudget(80_000, 100_000)).toBe(60_000);
    expect(contextBudget(undefined, 200_000)).toBe(120_000);
    expect(contextBudget(5_000, undefined)).toBe(5_000);
    expect(contextBudget(undefined, undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(contextBudget(0, Number.NaN)).toBe(Number.POSITIVE_INFINITY);
  });

  test("fit drops the lowest-scored units first (oldest on ties) and never a forced one, even over budget", () => {
    const units = [
      { id: "a", tokens: 100, score: 4, forced: false },
      { id: "b", tokens: 100, score: 2, forced: false },
      { id: "c", tokens: 100, score: 3, forced: false },
      { id: "d", tokens: 100, score: 2, forced: false },
      { id: "e", tokens: 100, score: 0, forced: true },
      { id: "f", tokens: 100, score: 1, forced: false },
    ];
    // below the relevance threshold goes regardless of the budget
    const all = fitToBudget(units, { budget: Infinity, minScore: 2 });
    expect([...all.keep].sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(all.dropped).toEqual(["f"]);
    // 400 budget: forced e + three of a,b,c,d; lowest score (b, then the older tie) goes first
    const tight = fitToBudget(units, { budget: 400, minScore: 2 });
    expect([...tight.keep].sort()).toEqual(["a", "c", "d", "e"]);
    expect(tight.overBudget).toBe(false);
    // 150 budget: only the forced unit survives although it alone is over... no: 100 <= 150, one more cannot fit
    const tiny = fitToBudget(units, { budget: 150, minScore: 2 });
    expect([...tiny.keep]).toEqual(["e"]);
    // forced units alone exceed the budget: still kept, flagged
    const over = fitToBudget([{ id: "x", tokens: 900, score: 0, forced: true }, ...units.slice(0, 2)], { budget: 100, minScore: 2 });
    expect([...over.keep]).toEqual(["x"]);
    expect(over.overBudget).toBe(true);
  });

  test("fit ties drop the OLDEST unit first", () => {
    const units = [
      { id: "old", tokens: 100, score: 3, forced: false },
      { id: "new", tokens: 100, score: 3, forced: false },
    ];
    expect([...fitToBudget(units, { budget: 100, minScore: 2 }).keep]).toEqual(["new"]);
  });
});

describe("message groups", () => {
  const convo = () => [
    userMsg("u1", "fix the parser in src/parser.ts"),
    assistantCalls(callPart("c1", "read", { filePath: "src/parser.ts" })),
    toolMsg(resultPart("c1", "read", "SECRET-BODY ".repeat(50))),
    assistantText("done", "a1"),
    userMsg("u2", "now add tests"),
    assistantText("ok", "a2"),
  ];

  test("units start at user messages; ids come from message ids; summaries are short and carry no tool output", () => {
    const units = groupMessages(convo());
    expect(units.map((u) => [u.id, u.start, u.end])).toEqual([
      ["u1", 0, 4],
      ["u2", 4, 6],
    ]);
    expect(units[0]!.summary).toContain("fix the parser");
    expect(units[0]!.summary).toContain("read");
    for (const u of units) {
      expect(u.summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
      expect(u.summary).not.toContain("SECRET-BODY");
      expect(u.tokens).toBeGreaterThan(0);
    }
  });

  test("messages without ids get stable index+hash ids; duplicate ids are made unique; leading messages form a unit", () => {
    const messages = [{ role: "assistant", content: [textPart("hello")] }, userMsg(undefined, "q1"), userMsg("dup", "q2"), userMsg("dup", "q3")];
    const a = groupMessages(messages);
    const b = groupMessages(structuredClone(messages));
    expect(a.map((u) => u.id)).toEqual(b.map((u) => u.id));
    expect(a[0]!.id).toMatch(/^m0-/);
    expect(a[1]!.id).toMatch(/^m1-/);
    expect(new Set(a.map((u) => u.id)).size).toBe(4);
  });

  test("a tool pair that spans a user message keeps both halves in ONE unit", () => {
    const messages = [
      userMsg("u1", "go"),
      assistantCalls(callPart("c1", "shell", { command: "sleep" })),
      userMsg("u2", "queued while the tool ran"),
      toolMsg(resultPart("c1", "shell", "done")),
      assistantText("ok"),
    ];
    const units = groupMessages(messages);
    expect(units).toHaveLength(1);
    expect(units[0]!.start).toBe(0);
    expect(units[0]!.end).toBe(5);
  });

  test("a big unit is split at points no pair crosses; pairs stay together", () => {
    const messages: unknown[] = [userMsg("u1", "start")];
    for (let i = 0; i < 6; i++) {
      messages.push(assistantCalls(callPart(`c${i}`, "read", {})), toolMsg(resultPart(`c${i}`, "read", "y".repeat(400))));
    }
    const units = groupMessages(messages, { unitMaxTokens: 150 });
    expect(units.length).toBeGreaterThan(2);
    for (const u of units) {
      const slice = messages.slice(u.start, u.end);
      expect(findOrphans(slice).filter((o) => !o.includes("nothing"))).toEqual(findOrphans(slice));
      const calls = slice.filter((m: any) => m.role === "assistant").length;
      const results = slice.filter((m: any) => m.role === "tool").length;
      expect(calls).toBe(results);
    }
  });

  test("garbage in: never throws, never mutates", () => {
    const junk = deepFreeze([null, 3, "x", { role: "user" }, { role: "user", content: 7 }, { content: [null, { type: "tool-call" }] }]);
    expect(() => groupMessages(junk)).not.toThrow();
    expect(groupMessages(junk).at(-1)!.end).toBe(junk.length);
    expect(groupMessages([])).toEqual([]);
    expect(conversationTokens(junk)).toBeGreaterThan(0);
    expect(analyze("nope", { keepRecentMessages: 1, keepFirstUser: true })).toBeNull();
    expect(analyze([assistantText("no user")], { keepRecentMessages: 1, keepFirstUser: true })).toBeNull();
  });
});

describe("forced messages", () => {
  const opts = { keepRecentMessages: 2, keepFirstUser: true };

  test("system, first/latest user and after, last N, compaction parts and leading messages are forced", () => {
    const messages = deepFreeze([
      { role: "assistant", content: [{ type: "compaction", provider: "p", text: "summary of before" }] }, // 0 leading + compaction
      userMsg("u1", "first"), // 1 first user
      assistantText("a1"),
      { role: "system", content: [textPart("note")] }, // 3 system (same unit as u1 -> forced)
      userMsg("u2", "second"),
      assistantText("a2"),
      userMsg("u3", "third"),
      assistantText("a3"),
      userMsg("u4", "latest"), // 8 latest
      assistantCalls(callPart("c", "read")), // 9
    ]);
    const a = analyze(messages, opts)!;
    expect(a.latestUser).toBe(8);
    const forced = (i: number) => a.forcedMessages.has(i);
    expect([0, 1, 2, 3, 8, 9].every(forced)).toBe(true);
    // u2 and u3 are free: not asked/dropped unless Jev says so
    expect(forced(4) || forced(5)).toBe(false);
    expect(a.units.map((u, k) => [u.id, a.forced[k]])).toEqual([
      ["m0-" + a.units[0]!.id.slice(3), true],
      ["u1", true],
      ["u2", false],
      ["u3", false],
      ["u4", true],
    ]);
  });

  test("keepFirstUser=false frees the first user unit; keepRecentMessages forces the tail units", () => {
    const messages = [userMsg("u1", "a"), assistantText("x"), userMsg("u2", "b"), assistantText("y"), userMsg("u3", "c")];
    const a = analyze(messages, { keepRecentMessages: 3, keepFirstUser: false })!;
    expect(a.units.map((u, k) => [u.id, a.forced[k]])).toEqual([["u1", false], ["u2", true], ["u3", true]]);
    const kept = applyDrop(messages, new Set(["u1", "u2", "u3"]), { keepRecentMessages: 3, keepFirstUser: false })!;
    expect(kept.dropped).toEqual(["u1"]);
    expect(kept.messages).toHaveLength(3);
  });

  test("applyDrop returns the original array when nothing is dropped, and never drops a forced unit", () => {
    const messages = [userMsg("u1", "a"), assistantText("x"), userMsg("u2", "b")];
    const none = applyDrop(messages, new Set(), opts)!;
    expect(none.messages).toBe(messages);
    const forcedOnly = applyDrop(messages, new Set(["u1", "u2"]), opts)!;
    expect(forcedOnly.dropped).toEqual([]);
    expect(forcedOnly.messages).toBe(messages);
  });
});

describe("collector and distiller", () => {
  const big = "SECRET-BODY-LINE ".repeat(400);

  function longConversation(n: number): unknown[] {
    const out: unknown[] = [userMsg("u0", "Please refactor the payment module in src/pay/index.ts and keep the API stable")];
    let k = 0;
    while (out.length < n) {
      const id = `call${k++}`;
      out.push(userMsg(`u${k}`, `step ${k}: look at src/mod${k % 17}.ts`));
      out.push(assistantCalls(callPart(id, k % 3 === 0 ? "edit" : "read", { filePath: `src/mod${k % 17}.ts` })));
      out.push(toolMsg(resultPart(id, k % 3 === 0 ? "edit" : "read", big, k % 11 === 0 ? "error" : "text")));
    }
    return out;
  }

  test("500 messages: state stays under the cap and never contains full tool output bodies", () => {
    const messages = deepFreeze(longConversation(500));
    const units = groupMessages(messages);
    const candidates = units.slice(0, 60).map((u) => ({ id: u.id, summary: u.summary, tokens: u.tokens }));
    const { state, included } = distill({ messages, candidates, totalTokens: conversationTokens(messages) });
    const json = JSON.stringify(state);
    expect(json.length).toBeLessThanOrEqual(DISTILL_MAX_CHARS);
    // each tool body is ~6800 chars; only <=100-char previews of error results may appear
    expect(json).not.toContain("SECRET-BODY-LINE ".repeat(10));
    for (const issue of state.unresolvedIssues) expect(issue.length).toBeLessThanOrEqual(130);
    expect(state.objective).toContain("refactor the payment module");
    expect(state.currentRequest).toContain("step");
    expect(state.activeFiles.length).toBeGreaterThan(0);
    expect(state.completedWork.length).toBeGreaterThan(0);
    expect(state.unresolvedIssues.length).toBeGreaterThan(0);
    expect(included).toHaveLength(60);
  });

  test("a tight cap shrinks the state (and drops the oldest candidates) instead of overflowing", () => {
    const messages = longConversation(200);
    const candidates = Array.from({ length: 60 }, (_, i) => ({ id: `unit-${i}-${"z".repeat(30)}`, summary: "s".repeat(150), tokens: 10 }));
    for (const maxChars of [3000, 1500, 800]) {
      const { state, included } = distill({ messages, candidates, totalTokens: 1, maxChars });
      expect(JSON.stringify(state).length).toBeLessThanOrEqual(maxChars);
      expect(state.contextCandidates).toEqual(included);
    }
  });

  test("collector heuristics", () => {
    const messages = [
      userMsg("u1", "see docs/readme.md and src\\win\\path.ts"),
      assistantCalls(callPart("1", "edit", { filePath: "src/a.ts" }), callPart("2", "apply_patch", { patchText: "*** Update File: src/b.ts\n@@" })),
      toolMsg(resultPart("1", "edit", "ok"), resultPart("2", "apply_patch", "Error: patch failed to apply")),
      assistantCalls(callPart("3", "shell", { command: "bun test --bail" })),
      toolMsg(resultPart("3", "shell", "fail", "error")),
    ];
    expect(filesOfInput({ filePath: "a.ts", path: "dir/b.ts", other: "ignored" })).toEqual(["a.ts", "dir/b.ts"]);
    const files = collectActiveFiles(messages);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/b.ts");
    expect(files).toContain("docs/readme.md");
    expect(collectCompletedWork(messages)).toEqual(["edit src/a.ts"]);
    const issues = collectUnresolvedIssues(messages);
    expect(issues[0]).toContain("shell");
    expect(issues.some((i) => i.includes("apply_patch"))).toBe(true);
    for (const i of issues) expect(i.length).toBeLessThanOrEqual(130);
    expect(collectActiveFiles(null as any)).toEqual([]);
  });
});
