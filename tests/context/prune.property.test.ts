import { describe, expect, test } from "bun:test";
import { findOrphans, groupMessages } from "../../src/context/message-groups.ts";
import { analyze, applyDrop, checkPrune, type PruneOptions } from "../../src/context/prune.ts";
import type { Answers, Questions } from "../../src/jev/types.ts";
import type { ContextEvent } from "../../src/opencode/context-hook.ts";
import { createContextRouter } from "../../src/router/context-router.ts";
import { fallbackPlan, type TurnPlan } from "../../src/router/plan.ts";
import { chance, deepFreeze, genConversation, int, rng, type Rand } from "./gen.ts";

const CASES = 600;
const log = { debug() {}, warn() {} };

const optionsFor = (r: Rand): PruneOptions => ({
  keepRecentMessages: int(r, 0, 8),
  keepFirstUser: chance(r, 0.7),
  unitMaxTokens: chance(r, 0.5) ? 1_000_000 : int(r, 8, 200),
});

function jevPlan(): TurnPlan {
  return { ...fallbackPlan("s1", "t1", "x"), source: "jev", fallbackReason: undefined };
}

describe("property: applyDrop never orphans a tool part and never loses a forced message", () => {
  test(`${CASES} random conversations x random drop sets (frozen inputs)`, () => {
    let pruned = 0;
    for (let seed = 1; seed <= CASES; seed++) {
      const r = rng(seed);
      const messages = deepFreeze(genConversation(r));
      expect(findOrphans(messages)).toEqual([]); // the generator makes well-formed conversations
      const opts = optionsFor(r);
      const analysis = analyze(messages, opts);
      expect(analysis).not.toBeNull();
      if (!analysis) continue;

      // units tile the messages exactly and no tool id spans two units
      let at = 0;
      for (const u of analysis.units) {
        expect(u.start).toBe(at);
        expect(u.end).toBeGreaterThan(u.start);
        at = u.end;
      }
      expect(at).toBe(messages.length);

      // "any Jev selection": every unit (forced or not) may be in the drop set, with any probability
      const p = r();
      const drop = new Set(analysis.units.filter(() => r() < p).map((u) => u.id));
      const result = applyDrop(messages, drop, opts, analysis);
      // a prune is allowed to be refused (null) but never to be wrong; with unsplit units it is never refused
      if (opts.unitMaxTokens! >= 1_000_000) expect(result).not.toBeNull();
      if (!result) continue;

      const out = result.messages;
      expect(findOrphans(out)).toEqual([]);
      for (const i of analysis.forcedMessages) expect(out).toContain(messages[i]);
      for (let i = analysis.latestUser; i < messages.length; i++) expect(out).toContain(messages[i]);
      // order preserved, same objects, nothing invented
      let cursor = -1;
      for (const m of out) {
        const idx = messages.indexOf(m);
        expect(idx).toBeGreaterThan(cursor);
        cursor = idx;
      }
      // forced units are never reported as dropped
      for (const id of result.dropped) {
        const k = analysis.units.findIndex((u) => u.id === id);
        expect(analysis.forced[k]).toBe(false);
      }
      if (result.dropped.length > 0) pruned++;
    }
    expect(pruned).toBeGreaterThan(CASES / 4); // the property was exercised on real prunes
  });

  test("checkPrune rejects an orphan, a dropped forced message and a changed first role", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "tool-call", id: "c", name: "read", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", id: "c", name: "read", result: { type: "text", value: "x" } }] },
      { role: "user", content: [{ type: "text", text: "b" }] },
    ];
    expect(checkPrune(msgs, [true, true, true, true], new Set([3]), 3)).toBeNull();
    expect(checkPrune(msgs, [true, true, false, true], new Set([3]), 3)).toContain("orphan");
    expect(checkPrune(msgs, [true, false, true, true], new Set([3]), 3)).toContain("orphan");
    expect(checkPrune(msgs, [true, true, true, false], new Set([3]), 3)).toContain("forced");
    expect(checkPrune(msgs, [false, true, true, true], new Set([3]), 3)).toContain("role");
  });
});

describe("property: the whole stage with a random Jev selection", () => {
  test(`${CASES} random conversations, random scores/confidences/failures`, async () => {
    let prunedCases = 0;
    let untouched = 0;
    for (let seed = 1000; seed < 1000 + CASES; seed++) {
      const r = rng(seed);
      const messages = deepFreeze(genConversation(r, { bodyChars: 400 }));
      const opts = optionsFor(r);
      const asks: Questions[] = [];
      const stage = createContextRouter({
        options: { keepRecentMessages: opts.keepRecentMessages, keepFirstUser: opts.keepFirstUser, pruneMinTokens: 0, contextMinConfidence: 0.5 },
        log,
        unitMaxTokens: opts.unitMaxTokens,
        maxQuestions: int(r, 2, 60),
        client: {
          async ask(_state, questions) {
            asks.push(questions);
            if (chance(r, 0.1)) return null;
            const answers: Answers = {};
            for (const name of Object.keys(questions)) {
              const roll = r();
              if (roll < 0.1) continue; // unanswered
              if (roll < 0.15) answers[name] = { kind: "noul", probability: 0.5 }; // wrong kind
              else answers[name] = { kind: "score", score: int(r, -2, 7), confidence: r() };
            }
            return answers;
          },
        },
      });
      const event: ContextEvent = { sessionID: "s1", agent: "jevCode", messages, system: [], tools: {} };
      const plan = jevPlan();
      await stage.apply(event, plan);
      expect(asks.length).toBeLessThanOrEqual(1);
      if (asks[0]) expect(Object.keys(asks[0]).length).toBeLessThanOrEqual(60);

      const out = event.messages as unknown[];
      expect(findOrphans(out)).toEqual([]);
      const analysis = analyze(messages, opts)!;
      for (const i of analysis.forcedMessages) expect(out).toContain(messages[i]);
      for (let i = analysis.latestUser; i < messages.length; i++) expect(out).toContain(messages[i]);
      if (out === messages) untouched++;
      else prunedCases++;

      // a continuation re-applies the same drops with no further Jev call
      const again: ContextEvent = { sessionID: "s1", agent: "jevCode", messages, system: [], tools: {} };
      await stage.apply(again, plan);
      expect(asks.length).toBeLessThanOrEqual(1);
      expect(again.messages).toEqual(out);
    }
    expect(prunedCases).toBeGreaterThan(50);
    expect(untouched).toBeGreaterThan(0);
  });
});

describe("grouping invariants", () => {
  test("no tool id spans two units, whatever the size cap", () => {
    for (let seed = 5000; seed < 5000 + 200; seed++) {
      const r = rng(seed);
      const messages = genConversation(r);
      const units = groupMessages(messages, { unitMaxTokens: int(r, 4, 300) });
      const unitOf = (i: number) => units.findIndex((u) => i >= u.start && i < u.end);
      const seen = new Map<string, number>();
      messages.forEach((m: any, i) => {
        for (const p of m.content ?? []) {
          if (p.type !== "tool-call" && p.type !== "tool-result") continue;
          const u = unitOf(i);
          if (seen.has(p.id)) expect(seen.get(p.id)).toBe(u);
          else seen.set(p.id, u);
        }
      });
      expect(new Set(units.map((u) => u.id)).size).toBe(units.length);
    }
  });
});
