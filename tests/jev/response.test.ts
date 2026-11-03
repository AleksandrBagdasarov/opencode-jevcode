import { describe, expect, test } from "bun:test";
import { noulProbability, pickChoice, rankNoul, scoreValue } from "../../src/jev/response.ts";
import { choiceQuestion, noulQuestion, scoreQuestion } from "../../src/jev/questions.ts";
import type { Answer, Answers } from "../../src/jev/types.ts";

const choice = (c: string, confidence: number): Answer => ({ kind: "choice", choice: c, confidence, probabilities: {} });

describe("pickChoice", () => {
  test("accepts allowed value at or above min confidence", () => {
    expect(pickChoice(choice("a", 0.8), ["a", "b"], 0.5)).toBe("a");
    expect(pickChoice(choice("a", 0.5), ["a"], 0.5)).toBe("a");
  });
  test("rejects values outside the allowed set", () => {
    expect(pickChoice(choice("evil/model", 0.99), ["a", "b"], 0.5)).toBeNull();
  });
  test("rejects low confidence, wrong kind, undefined, NaN confidence", () => {
    expect(pickChoice(choice("a", 0.49), ["a"], 0.5)).toBeNull();
    expect(pickChoice({ kind: "noul", probability: 1 }, ["a"], 0)).toBeNull();
    expect(pickChoice({ kind: "error", reason: "x" }, ["a"], 0)).toBeNull();
    expect(pickChoice(undefined, ["a"], 0)).toBeNull();
    expect(pickChoice(choice("a", NaN), ["a"], 0)).toBeNull();
  });
});

describe("noulProbability", () => {
  test("clamps to 0..1", () => {
    expect(noulProbability({ kind: "noul", probability: 1.7 })).toBe(1);
    expect(noulProbability({ kind: "noul", probability: -3 })).toBe(0);
    expect(noulProbability({ kind: "noul", probability: 0.42 })).toBe(0.42);
  });
  test("null for wrong kind, undefined, NaN", () => {
    expect(noulProbability(choice("a", 1))).toBeNull();
    expect(noulProbability(undefined)).toBeNull();
    expect(noulProbability({ kind: "noul", probability: NaN })).toBeNull();
  });
});

describe("rankNoul", () => {
  const answers: Answers = {
    "skill:a": { kind: "noul", probability: 0.7 },
    "skill:b": { kind: "noul", probability: 0.95 },
    "skill:c": { kind: "noul", probability: 0.2 },
    "skill:d": { kind: "error", reason: "x" },
    "tools:x": { kind: "noul", probability: 0.99 },
    "skill:e": { kind: "noul", probability: 5 },
  };
  test("filters by prefix and threshold, strips prefix, sorts desc", () => {
    expect(rankNoul(answers, "skill:", 0.6)).toEqual(["e", "b", "a"]);
  });
  test("threshold is inclusive; null answers give empty", () => {
    expect(rankNoul(answers, "skill:", 0.7)).toEqual(["e", "b", "a"]);
    expect(rankNoul(null, "skill:", 0)).toEqual([]);
  });
});

describe("scoreValue", () => {
  test("clamps to 0..max", () => {
    expect(scoreValue({ kind: "score", score: 9, confidence: 1 }, 4)).toBe(4);
    expect(scoreValue({ kind: "score", score: -1, confidence: 1 }, 4)).toBe(0);
    expect(scoreValue({ kind: "score", score: 2.5, confidence: 1 }, 4)).toBe(2.5);
  });
  test("null for wrong kind / undefined / NaN", () => {
    expect(scoreValue({ kind: "noul", probability: 1 }, 4)).toBeNull();
    expect(scoreValue(undefined, 4)).toBeNull();
    expect(scoreValue({ kind: "score", score: NaN, confidence: 1 }, 4)).toBeNull();
  });
});

describe("question builders", () => {
  test("build the Question union", () => {
    expect(choiceQuestion("i", { a: "A" })).toEqual({ kind: "choice", instructions: "i", options: { a: "A" } });
    expect(noulQuestion("i")).toEqual({ kind: "noul", instructions: "i" });
    expect(scoreQuestion("i", ["lo", "hi"])).toEqual({ kind: "score", instructions: "i", levels: ["lo", "hi"] });
  });
});
