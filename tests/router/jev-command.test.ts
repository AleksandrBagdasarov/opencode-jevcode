import { describe, expect, test } from "bun:test";
import {
  answerJevQuestion,
  FAILED_MESSAGE,
  JEV_COMMAND_NAME,
  jevCommandModule,
  NO_KEY_MESSAGE,
  USAGE_MESSAGE,
} from "../../src/opencode/jev-command.ts";
import { resolveOptions } from "../../src/config.ts";
import { createLogger } from "../../src/log.ts";
import type { Answers, Questions } from "../../src/jev/types.ts";

function client(answers: Answers | null, transport = "typesafe") {
  const asked: Array<{ state: unknown; questions: Questions }> = [];
  return {
    asked,
    ask: async (state: unknown, questions: Questions) => {
      asked.push({ state, questions });
      return answers;
    },
    describe: () => ({ transport }),
  };
}

describe("answerJevQuestion", () => {
  test("probability >= 0.5 is true, below is false", async () => {
    expect(await answerJevQuestion(client({ q: { kind: "noul", probability: 0.9 } }), true, "is the sky blue?")).toBe("true (0.900)");
    expect(await answerJevQuestion(client({ q: { kind: "noul", probability: 0.5 } }), true, "x")).toBe("true (0.500)");
    expect(await answerJevQuestion(client({ q: { kind: "noul", probability: 0.1 } }), true, "x")).toBe("false (0.100)");
  });

  test("sends the question in the state and one noul question", async () => {
    const c = client({ q: { kind: "noul", probability: 1 } });
    await answerJevQuestion(c, true, "  hello  ");
    expect(c.asked).toHaveLength(1);
    expect(c.asked[0]!.state).toEqual({ question: "hello" });
    expect(c.asked[0]!.questions.q!.kind).toBe("noul");
  });

  test("empty question returns usage and does not call Jev", async () => {
    const c = client(null);
    expect(await answerJevQuestion(c, true, "   ")).toBe(USAGE_MESSAGE);
    expect(c.asked).toHaveLength(0);
  });

  test("no key returns the key message and does not call Jev", async () => {
    const c = client(null, "none");
    expect(await answerJevQuestion(c, false, "x")).toBe(NO_KEY_MESSAGE);
    expect(NO_KEY_MESSAGE).toBe("Provide TYPESAFE_API_KEY or OPENROUTER_API_KEY");
    expect(c.asked).toHaveLength(0);
  });

  test("a failed request with a key returns the failure text", async () => {
    expect(await answerJevQuestion(client(null, "typesafe"), true, "x")).toBe(FAILED_MESSAGE);
  });

  test("a throwing client never throws", async () => {
    const bad = { ask: async () => { throw new Error("boom"); }, describe: () => ({ transport: "x" }) };
    expect(await answerJevQuestion(bad, true, "x")).toBe(FAILED_MESSAGE);
  });
});

describe("jevCommandModule", () => {
  test("registers /jev and posts the answer without resuming the session", async () => {
    const posted: Array<{ sessionID: string; text: string; resume?: boolean }> = [];
    let def: any;
    const ctx: any = {
      model: { list: async () => [] },
      experimental: { generate: { decisions: async () => ({}) } },
      command: { transform: async (cb: any) => { cb({ add: (d: unknown) => { def = d; } }); return { dispose() {} }; } },
      session: { synthetic: async (i: any) => { posted.push(i); } },
    };
    const options = resolveOptions({ provider: "none" }, {});
    await jevCommandModule.init(ctx, { options, log: createLogger({ sink: () => {} }), track: (x: any) => x });
    expect(def.name).toBe(JEV_COMMAND_NAME);
    await def.execute({ sessionID: "ses_1", prompt: { text: "anything" }, delivery: "queue" });
    expect(posted).toEqual([{ sessionID: "ses_1", text: NO_KEY_MESSAGE, resume: true }]);
  });
});
