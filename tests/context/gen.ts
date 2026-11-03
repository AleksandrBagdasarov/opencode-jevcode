/** Test helpers: a seeded PRNG, a random well-formed conversation generator and a deep freeze. */

export type Rand = () => number;

/** mulberry32: small deterministic PRNG. */
export function rng(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const int = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
export const chance = (r: Rand, p: number) => r() < p;

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export const textPart = (text: string) => ({ type: "text", text });
export const userMsg = (id: string | undefined, text: string) => ({ ...(id ? { id } : {}), role: "user", content: [textPart(text)] });
export const assistantText = (text: string, id?: string) => ({ ...(id ? { id } : {}), role: "assistant", content: [textPart(text)] });
export const callPart = (id: string, name: string, input: unknown = {}) => ({ type: "tool-call", id, name, input });
export const resultPart = (id: string, name: string, value: unknown = "ok", type: "text" | "error" = "text") => ({
  type: "tool-result",
  id,
  name,
  result: { type, value },
});

const TOOLS = ["read", "grep", "edit", "write", "shell", "glob"];
const WORDS = ["fix", "bug", "parser", "refactor", "test", "config", "login", "cache", "deploy", "schema", "lint", "build"];

const sentence = (r: Rand, n: number) => Array.from({ length: n }, () => WORDS[int(r, 0, WORDS.length - 1)]).join(" ");

/**
 * A random WELL-FORMED conversation: optional leading system message, 1..turns user turns, each with agent steps whose
 * tool calls have unique ids and results split / interleaved / merged in several ways, optional compaction messages,
 * messages with and without ids.
 */
export function genConversation(r: Rand, opts: { maxTurns?: number; bodyChars?: number } = {}): unknown[] {
  const out: unknown[] = [];
  let mid = 0;
  let cid = 0;
  const id = () => (chance(r, 0.7) ? `msg_${mid++}` : undefined);
  const body = () => "x".repeat(int(r, 1, opts.bodyChars ?? 200));
  if (chance(r, 0.2)) out.push({ role: "system", content: [textPart("system note")] });
  if (chance(r, 0.1)) out.push({ ...(id() ? { id: `msg_c${mid++}` } : {}), role: "assistant", content: [{ type: "compaction", provider: "p", text: "summary" }] });
  const turns = int(r, 1, opts.maxTurns ?? 12);
  for (let t = 0; t < turns; t++) {
    out.push(userMsg(id(), `${sentence(r, int(r, 2, 8))} src/file${t}.ts`));
    const steps = int(r, 0, 4);
    for (let s = 0; s < steps; s++) {
      const n = int(r, 1, 3);
      const calls = Array.from({ length: n }, () => {
        const name = TOOLS[int(r, 0, TOOLS.length - 1)]!;
        return { id: `call_${cid++}`, name, input: { filePath: `src/mod${int(r, 0, 5)}.ts`, command: sentence(r, 2) } };
      });
      const assistantParts: unknown[] = [];
      if (chance(r, 0.5)) assistantParts.push(textPart(sentence(r, 4)));
      for (const c of calls) assistantParts.push(callPart(c.id, c.name, c.input));
      const resultOf = (c: (typeof calls)[number]) => resultPart(c.id, c.name, body(), chance(r, 0.1) ? "error" : "text");
      const mode = int(r, 0, 3);
      if (mode === 0 && n === 1 && chance(r, 0.3)) {
        // provider-executed: call and result in the same message
        out.push({ ...(id() ? { id: `msg_${mid++}` } : {}), role: "assistant", content: [...assistantParts, resultOf(calls[0]!)] });
      } else {
        out.push({ ...(id() ? { id: `msg_${mid++}` } : {}), role: "assistant", content: assistantParts });
        if (mode === 1) {
          // one tool message per result, with chatter in between
          for (const c of calls) {
            out.push({ role: "tool", content: [resultOf(c)] });
            if (chance(r, 0.3)) out.push(assistantText(sentence(r, 3)));
          }
        } else if (mode === 2) {
          // results in reverse order, in separate messages
          for (const c of [...calls].reverse()) out.push({ ...(id() ? { id: `msg_${mid++}` } : {}), role: "tool", content: [resultOf(c)] });
        } else {
          out.push({ role: "tool", content: calls.map(resultOf) });
        }
      }
    }
    if (chance(r, 0.8)) out.push(assistantText(sentence(r, int(r, 3, 10)), id()));
  }
  return out;
}
