/** Leveled stderr logger with secret redaction. Logging never throws. */

export type Level = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, ...extra: unknown[]): void;
  info(msg: string, ...extra: unknown[]): void;
  warn(msg: string, ...extra: unknown[]): void;
  error(msg: string, ...extra: unknown[]): void;
  /** Register another secret value to redact (e.g. a key resolved later). */
  addSecret(secret: string | undefined): void;
}

export interface LoggerOptions {
  debug?: boolean;
  secrets?: Array<string | undefined>;
  /** Output sink; defaults to console.error. */
  sink?: (line: string) => void;
}

const PREFIX = "[jevcode]";
const MASK = "***";

// Common key shapes: TypeSafe `ts-...`, OpenRouter `sk-or-...`, generic `sk-...`, Bearer tokens.
const PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-or-[A-Za-z0-9_-]{4,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bts-[A-Za-z0-9_-]{4,}/g,
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redact(text: string, secrets: Iterable<string> = []): string {
  let out = text;
  // Longest first so a secret that contains another is masked fully.
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    if (s) out = out.replace(new RegExp(escapeRe(s), "g"), MASK);
  }
  for (const re of PATTERNS) out = out.replace(re, (m) => (/^bearer/i.test(m) ? `Bearer ${MASK}` : MASK));
  return out;
}

function show(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const secrets = new Set<string>();
  const add = (s: string | undefined) => {
    // Very short values would mask ordinary text; real keys are longer.
    if (s && s.length >= 4) secrets.add(s);
  };
  for (const s of opts.secrets ?? []) add(s);
  const sink = opts.sink ?? ((line: string) => console.error(line));

  const emit = (level: Level, msg: string, extra: unknown[]) => {
    if (level === "debug" && !opts.debug) return;
    try {
      const body = [msg, ...extra.map(show)].join(" ");
      const tag = level === "info" ? PREFIX : `${PREFIX} ${level}:`;
      sink(`${tag} ${redact(body, secrets)}`);
    } catch {
      // logging must never break the host
    }
  };

  return {
    debug: (m, ...e) => emit("debug", m, e),
    info: (m, ...e) => emit("info", m, e),
    warn: (m, ...e) => emit("warn", m, e),
    error: (m, ...e) => emit("error", m, e),
    addSecret: add,
  };
}
