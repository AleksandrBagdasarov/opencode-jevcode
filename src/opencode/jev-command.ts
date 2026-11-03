/**
 * `/jev <question>` - debug command. Sends one yes/no question straight to Jev and prints `true` or `false`
 * (a `noul` answer of 0.5 or more is `true`). The answer and probability are posted as synthetic session
 * input so OpenCode delivers it into the visible session transcript. Without a Jev key the answer is the
 * fixed error text below.
 * The command never throws and works in every agent (it does not touch routing state).
 */
import type { Module } from "../modules.ts";
import type { JevClient } from "../jev/client.ts";
import { noulQuestion } from "../jev/questions.ts";
import { jevClientFor, type JevClientCtx } from "./jev-client.ts";

export const JEV_COMMAND_NAME = "jev";
export const NO_KEY_MESSAGE = "Provide TYPESAFE_API_KEY or OPENROUTER_API_KEY";
export const USAGE_MESSAGE = "Usage: /jev <yes/no question>";
export const FAILED_MESSAGE = "Jev request failed (set debug: true and check the [jevcode] log lines)";

const QUESTION = "q";
const MAX_QUESTION_CHARS = 2000;

/** Pure part: question text in, reply text out. Never throws. */
export async function answerJevQuestion(
  client: Pick<JevClient, "ask">,
  hasKey: boolean,
  text: string,
): Promise<string> {
  try {
    const question = text.trim().slice(0, MAX_QUESTION_CHARS);
    if (question === "") return USAGE_MESSAGE;
    if (!hasKey) return NO_KEY_MESSAGE;
    const answers = await client.ask(
      { question },
      { [QUESTION]: noulQuestion("Is the statement or question in the state's `question` field true? Answer with the probability that it is yes/true.") },
    );
    const answer = answers?.[QUESTION];
    if (answer?.kind === "noul") {
      const probability = Math.min(1, Math.max(0, answer.probability));
      const verdict = probability >= 0.5 ? "true" : "false";
      return `${verdict} (${probability.toFixed(3)})`;
    }
    return FAILED_MESSAGE;
  } catch {
    return FAILED_MESSAGE;
  }
}

export interface JevCommandCtx extends JevClientCtx {
  readonly command: {
    transform(
      callback: (editor: {
        add(def: {
          name: string;
          description?: string;
          execute(input: { sessionID: string; prompt: { text?: string } }): Promise<void>;
        }): void;
      }) => void,
    ): Promise<{ dispose(): Promise<void> | void }>;
  };
  readonly session: {
    synthetic(input: { sessionID: string; text: string; resume?: boolean }): Promise<unknown>;
  };
}

export const jevCommandModule: Module<JevCommandCtx> = {
  name: "jev-command",
  async init(ctx, { options, log }) {
    log.debug("/jev: init start");
    const client = jevClientFor(ctx, options, log);
    // Not awaited: on OpenCode 2.2.5 `command.transform` resolves only after plugin setup has finished, so
    // awaiting it here would block setup (and every module after it). Disposal waits for the registration.
    const registration = ctx.command.transform((editor) => {
      editor.add({
        name: JEV_COMMAND_NAME,
        description: "Ask Jev a yes/no question and print true or false (checks the Jev API integration)",
        async execute({ sessionID, prompt }) {
          const reply = await answerJevQuestion(client, !!options.apiKey, typeof prompt?.text === "string" ? prompt.text : "");
          log.info(`/jev: ${reply}`);
          try {
            // `resume:false` leaves this in the inbox, invisible in the session transcript. Resume so
            // OpenCode delivers the synthetic reply into the active session and the TUI can show it.
            await ctx.session.synthetic({ sessionID, text: reply, resume: true });
          } catch (err) {
            log.warn("/jev: could not post the answer:", err);
          }
        },
      });
    }).then(
      (reg) => {
        log.debug("/jev command registered");
        return reg;
      },
      (err) => {
        log.error("could not register the /jev command:", err);
        return undefined;
      },
    );
    return async () => {
      try {
        await (await registration)?.dispose();
      } catch (err) {
        log.warn("/jev command cleanup failed:", err);
      }
    };
  },
};
