/**
 * Heuristic extraction of facts from `event.messages` for the compact ConversationState (story R5.1):
 * active files, completed work, unresolved issues. Everything returned is short (each item is clipped); full tool
 * output bodies are never copied. Every function is total (never throws).
 */

export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export const clip = (text: string, max: number): string => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
};

/** Parts of a message; a plain string content counts as one text part. */
export function partsOf(message: unknown): Record<string, unknown>[] {
  if (!isRecord(message)) return [];
  const content = message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

/** All text parts of a message joined by newlines. */
export function textOfMessage(message: unknown): string {
  return partsOf(message)
    .map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""))
    .filter((t) => t !== "")
    .join("\n");
}

const FILE_KEYS = ["filePath", "file_path", "filepath", "path", "file", "filename", "target", "destination", "oldPath", "newPath"];
const PATCH_FILE = /\*\*\* (?:Update|Add|Delete) File: (.+)/g;
const TEXT_PATH = /(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]{1,8}\b/g;
const WRITE_TOOL = /^(edit|write|multiedit|patch|apply_patch|create|delete|move|rename)/i;
const RUN_TOOL = /^(shell|bash|execute)$/i;

const looksLikePath = (s: string) => s.length > 0 && s.length <= 200 && !/[\r\n]/.test(s);

/** File paths a tool-call input refers to (known keys, and patch headers). */
export function filesOfInput(input: unknown): string[] {
  const out: string[] = [];
  if (!isRecord(input)) return out;
  for (const key of FILE_KEYS) {
    const v = input[key];
    if (typeof v === "string" && looksLikePath(v.trim())) out.push(v.trim());
  }
  for (const key of ["patch", "patchText", "diff"]) {
    const v = input[key];
    if (typeof v !== "string") continue;
    for (const m of v.matchAll(PATCH_FILE)) {
      const f = m[1]?.trim();
      if (f && looksLikePath(f)) out.push(f);
    }
  }
  return out;
}

/** First `max` characters of a tool result as text (never the whole body). */
export function previewResult(result: unknown, max: number): string {
  if (!isRecord(result)) return typeof result === "string" ? clip(result.slice(0, max * 2), max) : "";
  const value = result.value;
  if (typeof value === "string") return clip(value.slice(0, max * 2), max);
  if (Array.isArray(value)) {
    const text = value.map((p) => (isRecord(p) && typeof p.text === "string" ? p.text : "")).join(" ");
    return clip(text.slice(0, max * 2), max);
  }
  try {
    return clip((JSON.stringify(value) ?? "").slice(0, max * 2), max);
  } catch {
    return "";
  }
}

const ERROR_START = /^\W*(error|failed|failure|exception|traceback|fatal|panic|FAIL)\b/i;

/** True when a tool-result part reports an error. */
export function isErrorResult(part: Record<string, unknown>): boolean {
  const result = part.result;
  if (isRecord(result) && result.type === "error") return true;
  return ERROR_START.test(previewResult(result, 120));
}

interface ToolEvent {
  index: number;
  call?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

function toolEvents(messages: readonly unknown[]): ToolEvent[] {
  const byId = new Map<string, ToolEvent>();
  const out: ToolEvent[] = [];
  messages.forEach((m, index) => {
    for (const part of partsOf(m)) {
      if (part.type !== "tool-call" && part.type !== "tool-result") continue;
      const id = typeof part.id === "string" ? part.id : undefined;
      let ev = id ? byId.get(id) : undefined;
      if (!ev) {
        ev = { index };
        out.push(ev);
        if (id) byId.set(id, ev);
      }
      if (part.type === "tool-call") ev.call = part;
      else ev.result = part;
    }
  });
  return out;
}

function nameOf(part: Record<string, unknown> | undefined): string {
  return part && typeof part.name === "string" ? part.name : "";
}

/**
 * Files the conversation touched, most recent first: tool-call inputs (newest messages first), then paths written in
 * user messages. At most `limit`.
 */
export function collectActiveFiles(messages: readonly unknown[], limit: number = 12): string[] {
  const out: string[] = [];
  if (!Array.isArray(messages)) return out;
  const add = (f: string) => {
    const file = clip(f, 160);
    if (file && !out.includes(file)) out.push(file);
  };
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    for (const part of partsOf(messages[i])) {
      if (part.type === "tool-call") for (const f of filesOfInput(part.input)) add(f);
    }
  }
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i];
    if (!isRecord(m) || m.role !== "user") continue;
    for (const hit of textOfMessage(m).matchAll(TEXT_PATH)) add(hit[0]);
  }
  return out.slice(0, limit);
}

/** Short lines for successful write-like and run-like tool calls, oldest first, the newest `limit` of them. */
export function collectCompletedWork(messages: readonly unknown[], limit: number = 10): string[] {
  const lines: string[] = [];
  if (!Array.isArray(messages)) return lines;
  for (const ev of toolEvents(messages)) {
    if (!ev.call || !ev.result || isErrorResult(ev.result)) continue;
    const name = nameOf(ev.call);
    if (WRITE_TOOL.test(name)) {
      const files = filesOfInput(ev.call.input);
      lines.push(clip(`${name} ${files.slice(0, 2).join(", ")}`, 100));
    } else if (RUN_TOOL.test(name) && isRecord(ev.call.input)) {
      const cmd = ev.call.input.command ?? ev.call.input.code;
      if (typeof cmd === "string") lines.push(clip(`ran: ${cmd}`, 100));
    }
  }
  return lines.slice(-Math.max(0, limit));
}

/** Short lines for tool calls that ended in an error, the newest `limit` of them, newest first. */
export function collectUnresolvedIssues(messages: readonly unknown[], limit: number = 5): string[] {
  const issues: string[] = [];
  if (!Array.isArray(messages)) return issues;
  for (const ev of toolEvents(messages).reverse()) {
    if (issues.length >= limit) break;
    if (!ev.result || !isErrorResult(ev.result)) continue;
    const name = nameOf(ev.result) || nameOf(ev.call) || "tool";
    issues.push(clip(`${name}: ${previewResult(ev.result.result, 100)}`, 130));
  }
  return issues;
}
